// backend/pollers/chargeHistoryPoller.js
// A API Tupi armazena datas em UTC.
// Brasil = UTC-3. "Hoje" significa 00:00 BRT = 03:00 UTC do mesmo dia.

import { bffPost } from "../tupiClient.js"

// Brasil = UTC-3 (fixo, sem horário de verão)
// O cálculo usa Date.now() que é sempre UTC puro,
// independente do fuso local do servidor (pode estar em Europa, UTC+1, UTC+2, etc.)
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000  // 3h em ms

/**
 * Converte um timestamp UTC (string ISO) para hora BRT.
 * Usa aritmética UTC pura — não depende do fuso do servidor.
 */
function toBRTHour(dateStr) {
  if (!dateStr) return null
  // UTC ms - 3h = BRT ms → pega hora UTC do resultado (que representa hora BRT)
  const brtMs = new Date(dateStr).getTime() - BRT_OFFSET_MS
  return new Date(brtMs).getUTCHours()
}

/**
 * Retorna {startDate, endDate} em ISO UTC para a consulta à API.
 * Usa Date.now() (sempre UTC) — nunca depende do fuso local do servidor.
 *
 * "hoje" = 00:00:00 BRT → agora  =  03:00:00 UTC → agora UTC
 */
function getDateRange(periodo) {
  const nowUtcMs = Date.now()  // ms desde epoch, sempre UTC, independe do servidor

  // Calcula que dia é hoje em BRT usando UTC puro
  const nowBrtMs = nowUtcMs - BRT_OFFSET_MS
  const nowBrtDate = new Date(nowBrtMs)
  const brtYear  = nowBrtDate.getUTCFullYear()
  const brtMonth = nowBrtDate.getUTCMonth()
  const brtDay   = nowBrtDate.getUTCDate()

  // 00:00:00 BRT expresso em UTC = meia-noite UTC desse dia + 3h
  const midnightBrtUtcMs = Date.UTC(brtYear, brtMonth, brtDay) + BRT_OFFSET_MS

  const nowUtcIso = new Date(nowUtcMs).toISOString()

  if (periodo === "7d") {
    const startMs = midnightBrtUtcMs - 6 * 24 * 60 * 60 * 1000
    return { startDate: new Date(startMs).toISOString(), endDate: nowUtcIso }
  }
  if (periodo === "30d") {
    const startMs = midnightBrtUtcMs - 29 * 24 * 60 * 60 * 1000
    return { startDate: new Date(startMs).toISOString(), endDate: nowUtcIso }
  }
  // "hoje": 00:00 BRT (= 03:00 UTC) → agora
  return { startDate: new Date(midnightBrtUtcMs).toISOString(), endDate: nowUtcIso }
}

async function fetchAllPages(path, bodyFn) {
  const all = []
  let page = 1, totalPages = 1
  do {
    const data = await bffPost(path, bodyFn(page))
    if (data.docs?.length) all.push(...data.docs)
    totalPages = data.totalPages ?? 1
    page++
  } while (page <= totalPages)
  return all
}

/**
 * Extrai o valor de energia em kWh de uma transação.
 * Baseado na estrutura real confirmada da API Tupi:
 *   tx.meterValues.chargedEnergy = kWh (campo correto, ex: 9.95)
 *   tx.energyValue               = Wh  (campo monetário, ex: 1990 = 1.99 kWh — NÃO usar)
 */
function extractEnergia(tx) {
  // ÚNICO campo confiável em kWh — confirmado pela estrutura real da API
  const val = tx.meterValues?.chargedEnergy

  if (val === undefined || val === null) return 0

  const num = typeof val === "string" ? parseFloat(val.replace(",", ".")) : Number(val)
  if (isNaN(num) || num < 0) return 0

  return parseFloat(num.toFixed(3))
}

function consolidate(all) {
  const byStation = {}

  for (const tx of all) {
    const sid = tx.stationID
    if (!sid) continue

    if (!byStation[sid]) {
      byStation[sid] = {
        totalCargas:         0,
        bemSucedidas:        0,
        zeradas:             0,
        energiaTotal:        0,
        abortCount:          0,
        recentTxCount:       0,
        lastTx:              null,
        activeTxMeterFrozen: false,
        _uniqueUsers:        new Set(),
        _receita:            0,
        _hourCounts:         {},
        _connCounts:         {},
        _ultimaCarga:        null,
        _usuariosZeradas:    {},
      }
    }

    const s = byStation[sid]

    const energia  = extractEnergia(tx)
    const isAtiva  = tx.status === "active"

    // Cargas ativas ignoradas — igual ao Python que não conta "Carregando"
    if (isAtiva) continue

    // "finished" sem energia = zerada (ex: conexão que caiu antes de carregar)
    // "finished" com energia > 0 = bem sucedida
    const isZerada  = energia === 0
    const isSucesso = energia > 0

    const duracao = tx.stopDateTime && tx.startDateTime
      ? (new Date(tx.stopDateTime) - new Date(tx.startDateTime)) / 1000
      : null

    s.totalCargas++
    s.recentTxCount++

    if (isZerada) {
      s.zeradas++
      s.abortCount++
    } else if (isSucesso) {
      s.bemSucedidas++
      s.energiaTotal += energia
      if (tx.chargeFeesTotal) s._receita += tx.chargeFeesTotal
    }

    if (duracao !== null && duracao < 60) s.abortCount++

    // Última transação
    const txTs = tx.startDateTime ? new Date(tx.startDateTime).getTime() : null
    if (txTs && (!s.lastTx || txTs > s.lastTx)) {
      s.lastTx = txTs
      if (isSucesso) {
        s._ultimaCarga = {
          ts:            txTs,
          email:         tx.userEmail ?? tx.user?.email ?? null,
          energia:       parseFloat(energia.toFixed(2)),
          startDateTime: tx.startDateTime,
          connectorID:   tx.connectorID ?? tx.connectorId ?? null,
        }
      }
    }

    const email = tx.userEmail ?? tx.user?.email ?? null
    if (email) {
      s._uniqueUsers.add(email.toLowerCase())
      if (isZerada) s._usuariosZeradas[email.toLowerCase()] =
        (s._usuariosZeradas[email.toLowerCase()] ?? 0) + 1
    }

    // Hora no fuso BRT para horário de pico correto
    const horaBRT = toBRTHour(tx.startDateTime)
    if (horaBRT !== null) {
      const h = String(horaBRT)
      s._hourCounts[h] = (s._hourCounts[h] ?? 0) + 1
    }

    const conn = tx.connectorID ?? tx.connectorId
    if (conn) {
      const c = String(conn)
      s._connCounts[c] = (s._connCounts[c] ?? 0) + 1
    }
  }

  // Métricas finais
  for (const sid of Object.keys(byStation)) {
    const s = byStation[sid]

    s.abortRate = s.recentTxCount > 0 ? s.abortCount / s.recentTxCount : 0

    s.taxaSucesso = s.totalCargas > 0
      ? parseFloat(((s.bemSucedidas / s.totalCargas) * 100).toFixed(2))
      : 0

    s.mediaKwhPorRecarga = s.bemSucedidas > 0
      ? parseFloat((s.energiaTotal / s.bemSucedidas).toFixed(2))
      : 0

    s.energiaTotal = parseFloat(s.energiaTotal.toFixed(2))

    s.clientesUnicos = s._uniqueUsers.size
    s.receitaDia     = parseFloat((s._receita ?? 0).toFixed(2))

    const peakEntry = Object.entries(s._hourCounts).sort((a, b) => b[1] - a[1])[0]
    s.horarioPico = peakEntry ? `${peakEntry[0].padStart(2, "0")}h` : null

    const topConn = Object.entries(s._connCounts).sort((a, b) => b[1] - a[1])[0]
    s.connectorMaisUsado = topConn ? parseInt(topConn[0]) : null

    s.ultimaCarga = s._ultimaCarga ?? null

    s.usuariosZeradas = Object.entries(s._usuariosZeradas)
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)

    delete s._uniqueUsers
    delete s._receita
    delete s._hourCounts
    delete s._connCounts
    delete s._ultimaCarga
    delete s._usuariosZeradas
    delete s.abortCount
  }

  return byStation
}

export async function fetchChargeStats() {
  const { startDate, endDate } = getDateRange("hoje")
  console.log(`[chargePoller] hoje BRT: ${startDate} → ${endDate}`)
  const all = await fetchAllPages("/chargerHistory", (page) => ({
    page, limit: 100, show_zero_charges: true, startDate, endDate,
  }))
  console.log(`[chargePoller] ${all.length} transações encontradas`)
  return consolidate(all)
}

export async function fetchChargeStatsPeriod(periodo = "hoje") {
  const { startDate, endDate } = getDateRange(periodo)
  console.log(`[historico] ${periodo}: ${startDate} → ${endDate}`)
  const all = await fetchAllPages("/chargerHistory", (page) => ({
    page, limit: 100, show_zero_charges: true, startDate, endDate,
  }))
  console.log(`[historico] ${all.length} transações para ${periodo}`)
  return consolidate(all)
}