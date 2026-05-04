// backend/pollerService.js
import "dotenv/config"
import express from "express"
import cors    from "cors"
import Redis   from "ioredis"
import {
  ensureAuth,
  fetchConnectedStations,
  fetchStationNameMap,
  fetchOcppStations,
  fetchOcppTransactions,
} from "./tupiClient.js"
import { buildStationList, isInactiveStation } from "./statusEngine.js"
import { enrichWithPollers }                   from "./pollers/index.js"
import { saveAvailabilitySnapshot, getAllAvailability } from "./pollers/availabilityPoller.js"
import { saveAlertSnapshot, getAlertHistory }            from "./pollers/alertHistoryPoller.js"
import { fetchOcppLogs, analyzeOcppLogs }               from "./pollers/ocppAnalyzer.js"
import { fetchChargeStatsPeriod }              from "./pollers/chargeHistoryPoller.js"

const app = express()
app.use(cors({ origin: "http://localhost:5173" }))
app.use(express.json())

const pub = new Redis(process.env.REDIS_URL)
const sub = new Redis(process.env.REDIS_URL)
const kv  = new Redis(process.env.REDIS_URL)

const PORT          = process.env.PORT || 3001
const POLL_INTERVAL = 30_000
const CHANNEL       = "stations:update"
const MANUT_KEY     = "manutencoes:dinamicas"

// ─── SSE CLIENTS ─────────────────────────────────────────────────────────────
const sseClients = new Set()
sub.subscribe(CHANNEL)
sub.on("message", (_, msg) => {
  for (const client of sseClients)
    client.write(`event: snapshot\ndata: ${msg}\n\n`)
})

// ─── POLLING LOOP ─────────────────────────────────────────────────────────────
let stationList = []

async function poll() {
  try {
    await ensureAuth()

    const [connected, nameMap, ocppMap, ocppTxMap] = await Promise.all([
      fetchConnectedStations(),   // array de estações
      fetchStationNameMap(),      // mapa stationID → nome
      fetchOcppStations(),        // mapa stationID → dados OCPP
      fetchOcppTransactions(),    // mapa stationID → tx OCPP ativa
    ])

    // buildStationList recebe: (connected[], nameMap, ocppMap, txMap, ocppTxMap)
    // txMap = {} pois o BFF tx vem do chargeHistoryPoller
    const base = await buildStationList(connected, nameMap, ocppMap, {}, ocppTxMap, kv)

    // Filtra inativas antes de enriquecer
    const active = base.filter(s => !isInactiveStation(s))

    // Enriquece com cargas, logs e API pública
    const enriched = await enrichWithPollers(active)

    // Aplica manutenções dinâmicas do Redis
    const manutRaw = await kv.get(MANUT_KEY)
    const manutList = manutRaw ? JSON.parse(manutRaw) : []
    const manutMap  = Object.fromEntries(manutList.map(m => [m.stationID, m]))

    stationList = enriched.map(s => {
      const dm = manutMap[s.stationID]
      if (!dm) return s
      return {
        ...s,
        status:      "maintenance",
        statusSince: new Date(dm.since).getTime(),
        silentScore: 0,
        silentReasons: [],
        maintenanceInfo: {
          since:       new Date(dm.since),
          causa:       dm.causa       || "",
          responsavel: dm.responsavel || "",
          prioridade:  dm.prioridade  || "media",
          previsao:    dm.previsao ? new Date(dm.previsao) : null,
          observacoes: dm.observacoes || "",
          criadoEm:    dm.criadoEm    || null,
          dinamica:    true,
        },
      }
    })

    console.log(`[poll] ${stationList.length} estações ativas`)

    // Salva snapshots de disponibilidade e alertas no Redis
    saveAvailabilitySnapshot(kv, stationList).catch(()=>{})
    saveAlertSnapshot(kv, stationList).catch(()=>{})

    const payload = JSON.stringify(stationList)
    await pub.publish(CHANNEL, payload)
    await kv.set("stations:cache", payload, "EX", 120)

  } catch (err) {
    console.error("[poll] erro:", err.message)
  }
}

poll()
setInterval(poll, POLL_INTERVAL)

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

app.get("/api/stations", async (req, res) => {
  try {
    if (stationList.length) return res.json(stationList)
    const cached = await kv.get("stations:cache")
    if (cached) return res.json(JSON.parse(cached))
    res.json([])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
  })
  res.flushHeaders()
  if (stationList.length)
    res.write(`event: snapshot\ndata: ${JSON.stringify(stationList)}\n\n`)
  sseClients.add(res)
  req.on("close", () => sseClients.delete(res))
})

app.get("/api/alerts", (req, res) => {
  res.json(stationList.filter(s =>
    s.status === "offline" || s.status === "error" || s.portaAberta || s.silentScore >= 3
  ))
})

// ─── HISTÓRICO (7d / 30d) ────────────────────────────────────────────────────
app.get("/api/historico", async (req, res) => {
  try {
    const periodo  = req.query.periodo ?? "hoje"
    const cacheKey = `historico:${periodo}`

    if (periodo !== "hoje") {
      const cached = await kv.get(cacheKey)
      if (cached) return res.json(JSON.parse(cached))
    }

    await ensureAuth()
    const stats = await fetchChargeStatsPeriod(periodo)

    if (periodo === "7d")  await kv.set(cacheKey, JSON.stringify(stats), "EX", 600)
    if (periodo === "30d") await kv.set(cacheKey, JSON.stringify(stats), "EX", 1800)

    res.json(stats)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── ESTAÇÕES IGNORADAS (removidas do monitoramento) ─────────────────────────
const IGNORED_KEY = "estacoes:ignoradas"

app.get("/api/ignoradas", async (req, res) => {
  try {
    const raw = await kv.get(IGNORED_KEY)
    res.json(raw ? JSON.parse(raw) : [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/api/ignoradas/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params
    const { motivo } = req.body
    const raw   = await kv.get(IGNORED_KEY)
    const lista = raw ? JSON.parse(raw) : []
    if (!lista.find(s => s.stationID === stationID)) {
      lista.push({ stationID, motivo: motivo||"", removidoEm: new Date().toISOString() })
      await kv.set(IGNORED_KEY, JSON.stringify(lista))
      await kv.del("stations:cache")
      console.log(`[ignoradas] ${stationID} removida do monitoramento`)
    }
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete("/api/ignoradas/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params
    const raw   = await kv.get(IGNORED_KEY)
    const lista = raw ? JSON.parse(raw) : []
    await kv.set(IGNORED_KEY, JSON.stringify(lista.filter(s => s.stationID !== stationID)))
    await kv.del("stations:cache")
    console.log(`[ignoradas] ${stationID} restaurada ao monitoramento`)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── ENCERRAMENTO DE MANUTENÇÕES FIXAS ──────────────────────────────────────
const FIXED_ENDED_KEY = "manutencoes:fixas:encerradas"

app.post("/api/manutencoes/fixa/encerrar/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params

    // 1. Adiciona à lista de fixas encerradas
    const raw   = await kv.get(FIXED_ENDED_KEY)
    const lista = raw ? JSON.parse(raw) : []
    if (!lista.includes(stationID)) lista.push(stationID)
    await kv.set(FIXED_ENDED_KEY, JSON.stringify(lista))

    // 2. Remove também qualquer entrada dinâmica com o mesmo stationID
    const manutRaw   = await kv.get(MANUT_KEY)
    const manutLista = manutRaw ? JSON.parse(manutRaw) : []
    const manutFiltrada = manutLista.filter(m => m.stationID !== stationID)
    await kv.set(MANUT_KEY, JSON.stringify(manutFiltrada))

    await kv.del("stations:cache")
    console.log(`[manutencao-fixa] encerrada: ${stationID}`)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete("/api/manutencoes/fixa/encerrar/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params
    const raw   = await kv.get(FIXED_ENDED_KEY)
    const lista = raw ? JSON.parse(raw) : []
    await kv.set(FIXED_ENDED_KEY, JSON.stringify(lista.filter(s => s !== stationID)))
    await kv.del("stations:cache")
    console.log(`[manutencao-fixa] restaurada: ${stationID}`)
    res.json({ ok: true })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── MANUTENÇÕES DINÂMICAS ────────────────────────────────────────────────────

app.get("/api/manutencoes", async (req, res) => {
  try {
    const raw = await kv.get(MANUT_KEY)
    res.json(raw ? JSON.parse(raw) : [])
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.post("/api/manutencoes", async (req, res) => {
  try {
    const { stationID, since, causa, responsavel, prioridade, previsao, observacoes } = req.body
    if (!stationID || !since)
      return res.status(400).json({ error: "stationID e since são obrigatórios" })
    const raw   = await kv.get(MANUT_KEY)
    const lista = raw ? JSON.parse(raw) : []
    const idx   = lista.findIndex(m => m.stationID === stationID)
    const reg   = {
      stationID, since: new Date(since).toISOString(),
      causa: causa||"", responsavel: responsavel||"",
      prioridade: prioridade||"media",
      previsao: previsao ? new Date(previsao).toISOString() : null,
      observacoes: observacoes||"",
      criadoEm: new Date().toISOString(),
    }
    if (idx >= 0) lista[idx] = reg; else lista.push(reg)
    await kv.set(MANUT_KEY, JSON.stringify(lista))
    await kv.del("stations:cache")
    console.log(`[manutencao] ${idx >= 0 ? "atualizada" : "criada"}: ${stationID}`)
    res.json({ ok: true, registro: reg })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.delete("/api/manutencoes/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params
    const raw   = await kv.get(MANUT_KEY)
    const lista = raw ? JSON.parse(raw) : []
    await kv.set(MANUT_KEY, JSON.stringify(lista.filter(m => m.stationID !== stationID)))
    await kv.del("stations:cache")
    console.log(`[manutencao] removida: ${stationID}`)
    res.json({ ok: true, removido: stationID })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.patch("/api/manutencoes/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params
    const raw   = await kv.get(MANUT_KEY)
    const lista = raw ? JSON.parse(raw) : []
    const idx   = lista.findIndex(m => m.stationID === stationID)
    if (idx < 0) return res.status(404).json({ error: "Manutenção não encontrada" })
    lista[idx] = { ...lista[idx], ...req.body, stationID, atualizadoEm: new Date().toISOString() }
    await kv.set(MANUT_KEY, JSON.stringify(lista))
    await kv.del("stations:cache")
    res.json({ ok: true, registro: lista[idx] })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── LOGS OCPP DE UMA ESTAÇÃO ────────────────────────────────────────────────

app.get("/api/ocpp-logs/:stationID", async (req, res) => {
  try {
    const { stationID } = req.params
    const date  = req.query.date ?? new Date().toISOString().split("T")[0]
    const cacheKey = `ocpp_logs:${stationID}:${date}`

    // Cache de 2min para não sobrecarregar a API
    const cached = await kv.get(cacheKey)
    if (cached) return res.json(JSON.parse(cached))

    await ensureAuth()
    const logs     = await fetchOcppLogs(stationID, date)
    const analysis = analyzeOcppLogs(stationID, logs)

    const result = {
      stationID,
      date,
      totalLogs: logs.length,
      analysis,
    }

    await kv.set(cacheKey, JSON.stringify(result), "EX", 120)
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── HISTÓRICO DE ALERTAS ────────────────────────────────────────────────────

app.get("/api/alertas/historico", async (req, res) => {
  try {
    const dias = parseInt(req.query.dias ?? "7")
    const cacheKey = `alertas_hist:${dias}d`
    const cached = await kv.get(cacheKey)
    if (cached) return res.json(JSON.parse(cached))
    const result = await getAlertHistory(kv, stationList, dias)
    await kv.set(cacheKey, JSON.stringify(result), "EX", 60)
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── DISPONIBILIDADE ─────────────────────────────────────────────────────────

app.get("/api/disponibilidade", async (req, res) => {
  try {
    const dias     = parseInt(req.query.dias ?? "1")
    const cacheKey = `disponibilidade:${dias}d`
    const cached   = await kv.get(cacheKey)
    if (cached) return res.json(JSON.parse(cached))
    const result = await getAllAvailability(kv, stationList, dias)
    await kv.set(cacheKey, JSON.stringify(result), "EX", 60)
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

app.get("/api/disponibilidade/relatorio", async (req, res) => {
  try {
    const dias   = parseInt(req.query.dias ?? "1")
    const result = await getAllAvailability(kv, stationList, dias)

    const rows   = Object.values(result).sort((a,b) => a.disponibilidade - b.disponibilidade)
    const media  = rows.length
      ? (rows.reduce((a,r) => a + (r.disponibilidade ?? 0), 0) / rows.length).toFixed(2)
      : "—"

    const brtNow = new Date(Date.now() - 3*3600000)
    const dtStr  = brtNow.toLocaleString("pt-BR", {timeZone:"UTC"})

    function dispCorHex(pct) {
      if (pct === null) return "#9ca3af"
      if (pct >= 95)   return "#16a34a"
      if (pct >= 80)   return "#d97706"
      return "#dc2626"
    }

    function analise(r) {
      const pct   = r.disponibilidade
      const disc  = r.totalDisc1006 ?? 0
      const quedas= r.totalQuedas   ?? 0
      const min   = r.totalMinOffline ?? 0
      const msgs  = []

      if (pct === null) return "Sem dados de disponibilidade para o período selecionado."
      if (pct >= 99)    return "Operação excelente. Nenhuma ação necessária."

      if (pct < 50)
        msgs.push(`Disponibilidade crítica de ${pct}% — estação ficou offline por ${min} minutos no período.`)
      else if (pct < 80)
        msgs.push(`Disponibilidade baixa de ${pct}% — ${min} minutos offline registrados.`)
      else if (pct < 95)
        msgs.push(`Disponibilidade abaixo do ideal (${pct}%) — pequenas interrupções detectadas.`)

      if (disc >= 5)
        msgs.push(`${disc} desconexões OCPP (código 1006) — possível instabilidade de rede ou reinicializações frequentes do equipamento.`)
      else if (disc > 0)
        msgs.push(`${disc} desconexão(ões) OCPP 1006 registrada(s).`)

      if (quedas >= 3)
        msgs.push(`${quedas} quedas de heartbeat — recomenda-se verificação física do equipamento e da conexão de rede.`)

      if (!msgs.length) msgs.push(`Disponibilidade de ${pct}% com ${quedas} queda(s). Monitorar.`)
      return msgs.join(" ")
    }

    const rowsHtml = rows.map(r => {
      const cor   = dispCorHex(r.disponibilidade)
      const pct   = r.disponibilidade != null ? `${r.disponibilidade}%` : "—"
      const min   = r.totalMinOffline > 0 ? `${Math.floor(r.totalMinOffline/60)}h ${r.totalMinOffline%60}min` : "—"
      const txt   = analise(r)
      const badge = r.disponibilidade >= 95 ? "✅" : r.disponibilidade >= 80 ? "⚠️" : "❌"
      return `
        <tr>
          <td style="padding:10px 12px;font-family:monospace;font-weight:700;color:#1a4fa0;white-space:nowrap">${r.stationID}</td>
          <td style="padding:10px 12px;font-size:12px;color:#374151">${r.name?.replace(/ZON \([A-Z]+\) /g,"") ?? ""}</td>
          <td style="padding:10px 12px;font-weight:800;color:${cor};text-align:center">${badge} ${pct}</td>
          <td style="padding:10px 12px;text-align:center;color:#374151">${r.totalQuedas ?? 0}</td>
          <td style="padding:10px 12px;text-align:center;color:#374151">${r.totalDisc1006 ?? 0}</td>
          <td style="padding:10px 12px;color:#374151">${min}</td>
          <td style="padding:10px 12px;font-size:11px;color:#4b5563;line-height:1.5">${txt}</td>
        </tr>`
    }).join("")

    const criticas = rows.filter(r => r.disponibilidade !== null && r.disponibilidade < 80)
    const alertas  = rows.filter(r => r.disponibilidade !== null && r.disponibilidade >= 80 && r.disponibilidade < 95)
    const boas     = rows.filter(r => r.disponibilidade !== null && r.disponibilidade >= 95)

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<title>Relatório de Disponibilidade ZON Charge</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, Arial, sans-serif; color: #111827; background: #f0f2f5; }
  .page { max-width: 1100px; margin: 0 auto; padding: 32px; }
  .header { background: #0f1e35; color: white; padding: 28px 32px; border-radius: 12px; margin-bottom: 24px; }
  .header h1 { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
  .header p  { font-size: 13px; opacity: .7; }
  .kpis { display: grid; grid-template-columns: repeat(4,1fr); gap: 16px; margin-bottom: 24px; }
  .kpi  { background: white; border-radius: 10px; padding: 18px 20px; border: 1px solid #e5e7eb; }
  .kpi .val { font-size: 28px; font-weight: 800; }
  .kpi .lbl { font-size: 11px; color: #6b7280; margin-top: 4px; text-transform: uppercase; letter-spacing: .05em; }
  .section { background: white; border-radius: 10px; padding: 24px; margin-bottom: 20px; border: 1px solid #e5e7eb; }
  .section h2 { font-size: 15px; font-weight: 700; margin-bottom: 16px; color: #0f1e35; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { background: #f3f4f6; font-size: 10px; font-weight: 700; color: #6b7280; text-transform: uppercase;
       letter-spacing: .06em; padding: 10px 12px; text-align: left; border-bottom: 2px solid #e5e7eb; }
  tr:nth-child(even) td { background: #fafbfc; }
  td { border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  .footer { text-align: center; font-size: 11px; color: #9ca3af; margin-top: 24px; }
  @media print {
    body { background: white; }
    .page { padding: 16px; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>ZON Charge — Relatório de Disponibilidade</h1>
    <p>Período: últimas ${dias === 1 ? "24 horas" : `${dias} dias`} &nbsp;·&nbsp; Gerado em ${dtStr}</p>
  </div>

  <div class="kpis">
    <div class="kpi">
      <div class="val" style="color:#1a4fa0">${rows.length}</div>
      <div class="lbl">Estações analisadas</div>
    </div>
    <div class="kpi">
      <div class="val" style="color:${parseFloat(media)>=95?"#16a34a":parseFloat(media)>=80?"#d97706":"#dc2626"}">${media}%</div>
      <div class="lbl">Disponibilidade média</div>
    </div>
    <div class="kpi">
      <div class="val" style="color:${criticas.length>0?"#dc2626":"#16a34a"}">${criticas.length}</div>
      <div class="lbl">Estações críticas (&lt;80%)</div>
    </div>
    <div class="kpi">
      <div class="val" style="color:#16a34a">${boas.length}</div>
      <div class="lbl">Excelente disponibilidade (≥95%)</div>
    </div>
  </div>

  <div class="section">
    <h2>Análise por estação</h2>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>Nome</th><th>Disponibilidade</th>
          <th>Quedas</th><th>Disc. 1006</th><th>Tempo offline</th><th>Análise</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>

  <div class="footer">
    ZON Sentinela · Relatório automático · ${dtStr}
  </div>
</div>
</body>
</html>`

    res.setHeader("Content-Type", "text/html; charset=utf-8")
    res.setHeader("Content-Disposition", `inline; filename="disponibilidade_${dias}d.html"`)
    res.send(html)
  } catch (err) { res.status(500).json({ error: err.message }) }
})



app.get("/api/disponibilidade", async (req, res) => {
  try {
    const dias   = parseInt(req.query.dias ?? "7")
    const cacheKey = `disponibilidade:${dias}d`
    const cached = await kv.get(cacheKey)
    if (cached) return res.json(JSON.parse(cached))

    const result = await getAllAvailability(kv, stationList, dias)
    await kv.set(cacheKey, JSON.stringify(result), "EX", 120) // cache 2min
    res.json(result)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`[server] porta ${PORT}`))