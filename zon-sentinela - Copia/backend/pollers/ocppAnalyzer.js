// ocppAnalyzer.js
// Analisa logs OCPP de estações indisponíveis para detectar falsos indisponíveis
// Usa tupi-ocpp-logs.tupinrg.app/api/v1

import { bffGet } from "../tupiClient.js"

const OCPP_LOGS_BASE = "https://tupi-ocpp-logs.tupinrg.app/api/v1"

// ─── FETCH LOGS ───────────────────────────────────────────────────────────────

export async function fetchOcppLogs(stationID, date) {
  try {
    const dateStr = date ?? new Date().toISOString().split("T")[0]
    const url = `/proxy-ocpp/logs?stationID=${stationID}&date=${dateStr}`
    const data = await bffGet(url)
    return Array.isArray(data) ? data : data.docs ?? data.logs ?? []
  } catch {
    // Tenta endpoint alternativo direto
    try {
      const dateStr = date ?? new Date().toISOString().split("T")[0]
      const res = await fetch(
        `${OCPP_LOGS_BASE}/logs?stationID=${stationID}&date=${dateStr}`,
        { headers: { "Content-Type": "application/json" } }
      )
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data) ? data : data.docs ?? data.logs ?? []
    } catch {
      return []
    }
  }
}

// ─── REGEX PIPELINE (equivalente ao tupi_logs.py) ────────────────────────────

const RE = {
  timestamp:      /\[(\d{2}-\d{2}-\d{4}\s\d{2}:\d{2}(?::\d{2})?)\]/,
  action:         /"(Heartbeat|StatusNotification|StartTransaction|StopTransaction|MeterValues|BootNotification|Authorize|RemoteStartTransaction|RemoteStopTransaction|ChangeAvailability|DisconnectNotification)"/,
  transactionId:  /"transactionId"\s*:\s*(\d+)/,
  connectorId:    /"connectorId"\s*:\s*(\d+)/,
  status:         /"status"\s*:\s*"([^"]+)"/,
  errorCode:      /"errorCode"\s*:\s*"([^"]+)"/,
  info:           /"info"\s*:\s*"([^"]+)"/i,
  vendorError:    /"vendorErrorCode"\s*:\s*"([^"]+)"/,
  disconnect1006: /"code"\s*:\s*1006/,
  // MeterValues sampledValue
  power:          /"Power\.Active\.Import"[\s\S]*?"value"\s*:\s*"([\d.]+)"/,
  current:        /"Current\.Import"[\s\S]*?"value"\s*:\s*"([\d.]+)"/,
  energy:         /"Energy\.Active\.Import\.Register"[\s\S]*?"value"\s*:\s*"([\d.]+)"/,
  // Formato alternativo Tupi
  chargedEnergy:  /"chargedEnergy"\s*:\s*([\d.]+)/,
  currentAmp:     /"currentCurrent"\s*:\s*([\d.]+)/,
  currentPow:     /"currentPower"\s*:\s*([\d.]+)/,
}

function parseTimestamp(str) {
  if (!str) return null
  // dd-mm-yyyy HH:MM ou dd-mm-yyyy HH:MM:SS
  const m = str.match(/(\d{2})-(\d{2})-(\d{4})\s(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return null
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]??'00'}`).getTime()
}

function extractText(log) {
  if (typeof log === "string") return log
  if (log.message)  return String(log.message)
  if (log.raw)      return String(log.raw)
  if (log.log)      return String(log.log)
  return JSON.stringify(log)
}

// Filtra vendorErrorCode — ignora "0", "0,0", "0,0,0,0" etc.
function isRealVendorError(code) {
  if (!code) return false
  return !code.split(",").map(p => p.trim()).every(p => p === "0")
}

// ─── ANALISADOR PRINCIPAL ─────────────────────────────────────────────────────

export function analyzeOcppLogs(stationID, logs) {
  const now = Date.now()

  // Parseia cada linha de log
  const parsed = logs.map(log => {
    const text = extractText(log)
    const ts   = parseTimestamp((text.match(RE.timestamp) || [])[1])
    return {
      ts,
      text,
      action:      (text.match(RE.action)       || [])[1] ?? null,
      txId:        (text.match(RE.transactionId) || [])[1] ?? null,
      connId:      (text.match(RE.connectorId)   || [])[1] ?? null,
      status:      (text.match(RE.status)        || [])[1] ?? null,
      errorCode:   (text.match(RE.errorCode)     || [])[1] ?? null,
      info:        (text.match(RE.info)          || [])[1] ?? null,
      vendorError: (text.match(RE.vendorError)   || [])[1] ?? null,
      power:       parseFloat((text.match(RE.power)    || [])[1] ?? (text.match(RE.currentPow) || [])[1] ?? 0),
      current:     parseFloat((text.match(RE.current)  || [])[1] ?? (text.match(RE.currentAmp) || [])[1] ?? 0),
      energy:      parseFloat((text.match(RE.energy)   || [])[1] ?? (text.match(RE.chargedEnergy) || [])[1] ?? 0),
      disc1006:    RE.disconnect1006.test(text),
    }
  }).filter(p => p.action || p.ts) // descarta linhas sem informação útil

  // Ordena por timestamp
  parsed.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  const heartbeats = parsed.filter(p => p.action === "Heartbeat" && p.ts)
  const lastHbTs   = heartbeats.length ? heartbeats.at(-1).ts : null
  const hbAgeMs    = lastHbTs ? now - lastHbTs : Infinity
  const hasRecentHb = hbAgeMs < 6 * 60 * 1000

  // ── StatusNotification — último status por conector ────────────────────────
  const statusByConnector = {}
  parsed.filter(p => p.action === "StatusNotification").forEach(p => {
    const cid = p.connId ?? "0"
    if (!statusByConnector[cid] || (p.ts ?? 0) > (statusByConnector[cid].ts ?? 0)) {
      statusByConnector[cid] = p
    }
  })
  const connectorStatuses = Object.entries(statusByConnector).map(([cid, p]) => ({
    connectorId: parseInt(cid),
    status:      p.status,
    errorCode:   p.errorCode,
    info:        p.info,
    vendorError: p.vendorError,
    ts:          p.ts,
  }))

  // ── Transações ────────────────────────────────────────────────────────────
  const starts = parsed.filter(p => p.action === "StartTransaction" && p.txId)
  const stops  = parsed.filter(p => p.action === "StopTransaction"  && p.txId)
  const stopIds = new Set(stops.map(p => p.txId))

  // StartTransaction sem StopTransaction = transação ativa
  const activeTx = starts.filter(p => !stopIds.has(p.txId))

  // ── MeterValues — energia fluindo ─────────────────────────────────────────
  const meters = parsed.filter(p => p.action === "MeterValues")
  const lastMeter = meters.length ? meters.at(-1) : null
  const meterAgeMs = lastMeter?.ts ? now - lastMeter.ts : Infinity

  // Pega valores do último MeterValues
  const finalPower   = lastMeter?.power   ?? 0
  const finalCurrent = lastMeter?.current ?? 0
  const finalEnergy  = lastMeter?.energy  ?? 0

  // Energia aumentando? Compara primeiro e último MeterValues
  let energyIncreasing = false
  if (meters.length >= 2) {
    const firstE = meters[0].energy
    const lastE  = meters.at(-1).energy
    energyIncreasing = lastE > firstE
  }

  const hasEnergyFlowing = finalPower > 0 || finalCurrent > 0 || energyIncreasing

  // ── Detecção de eventos — conta TODAS as ocorrências do dia ─────────────────
  const events = []

  // BOX_DOOR_OPEN — todas as ocorrências com timestamp
  parsed.filter(p => p.info?.toLowerCase() === "boxdoorisopen").forEach(p => {
    events.push({ type: "BOX_DOOR_OPEN", ts: p.ts, connector: p.connId })
  })

  // EMERGENCY_STOP — todas as ocorrências
  parsed.filter(p => p.info?.toLowerCase() === "emergencystop").forEach(p => {
    events.push({ type: "EMERGENCY_STOP", ts: p.ts })
  })

  // VENDOR_ERROR — replica lógica do tupi_logs.py:
  // Separa por vírgula, filtra zeros, registra cada código não-zero individualmente
  parsed.filter(p => isRealVendorError(p.vendorError)).forEach(p => {
    const partes = p.vendorError.split(",").map(x => x.trim()).filter(x => x && x !== "0")
    partes.forEach(parte => {
      events.push({ type: "VENDOR_ERROR", code: parte, ts: p.ts, connector: p.connId, errorCode: p.errorCode })
    })
  })

  // FIRMWARE — registra versão como no Python (FIRMWARE_x.x.x)
  const fwMatches = [...new Set(parsed.map(p => {
    const m = (typeof p.text === "string" ? p.text : "").match(/"firmwareVersion"\s*:\s*"([^"]+)"/)
    return m ? m[1] : null
  }).filter(Boolean))]
  fwMatches.forEach(fw => {
    events.push({ type: "FIRMWARE", code: `FIRMWARE_${fw}`, ts: null })
  })

  // DISCONNECT_1006 — conta todas as quedas com timestamp
  parsed.filter(p => p.disc1006).forEach(p => {
    events.push({ type: "QUEDA_CONEXAO", ts: p.ts })
  })

  // STATUS_FAULTED — toda vez que um conector foi para Faulted/Unavailable
  parsed.filter(p => p.action === "StatusNotification" && ["Faulted","Unavailable"].includes(p.status)).forEach(p => {
    events.push({ type: "STATUS_FAULTED", ts: p.ts, connector: p.connId, status: p.status, errorCode: p.errorCode, vendorError: p.vendorError })
  })

  // ── CLASSIFICAÇÃO — fonte de verdade = logs ────────────────────────────────
  let correctedStatus = "unknown"
  let justification   = ""
  let isInconsistent  = false

  const reportedFaulted = connectorStatuses.some(c =>
    ["Unavailable", "Faulted"].includes(c.status)
  )

  // 1. EM RECARGA — evidência direta nos logs
  const isCharging =
    activeTx.length > 0 ||
    hasEnergyFlowing ||
    meterAgeMs < 10 * 60 * 1000  // MeterValues nos últimos 10min

  if (isCharging) {
    correctedStatus = "charging"
    const reasons = []
    if (activeTx.length > 0)        reasons.push(`StartTransaction ativo (txId: ${activeTx.map(t=>t.txId).join(",")})`)
    if (finalPower > 0)             reasons.push(`potência: ${finalPower}W`)
    if (finalCurrent > 0)           reasons.push(`corrente: ${finalCurrent}A`)
    if (energyIncreasing)           reasons.push(`energia crescente: ${finalEnergy} Wh`)
    if (meterAgeMs < 10 * 60 * 1000) reasons.push(`MeterValues recente (${Math.round(meterAgeMs/60000)}min atrás)`)
    justification = reasons.join(" | ")
    if (reportedFaulted) isInconsistent = true
    return buildResult()
  }

  // 2. BOX_DOOR_OPEN — crítico
  if (events.find(e => e.type === "BOX_DOOR_OPEN")) {
    correctedStatus = "error"
    justification   = "BOX_DOOR_OPEN detectado: info=BoxDoorIsOpen no StatusNotification"
    return buildResult()
  }

  // 3. EMERGENCY_STOP — crítico
  if (events.find(e => e.type === "EMERGENCY_STOP")) {
    correctedStatus = "error"
    justification   = "EMERGENCY_STOP detectado nos logs"
    return buildResult()
  }

  // 4. Offline — sem heartbeat recente
  if (!hasRecentHb) {
    correctedStatus = "offline"
    justification   = lastHbTs
      ? `Último heartbeat há ${Math.round(hbAgeMs/60000)}min`
      : "Sem heartbeat registrado hoje"
    return buildResult()
  }

  // 5. Erro — todos os conectores Faulted/Unavailable
  if (connectorStatuses.length > 0 &&
      connectorStatuses.every(c => ["Faulted","Unavailable"].includes(c.status))) {
    correctedStatus = "error"
    justification   = `Todos os conectores em ${connectorStatuses.map(c=>`C${c.connectorId}:${c.status}`).join(", ")} com heartbeat ativo`
    return buildResult()
  }

  // 6. Operante — heartbeat + Available
  if (hasRecentHb && connectorStatuses.every(c => c.status === "Available")) {
    correctedStatus = "operational"
    justification   = `Heartbeat recente + todos conectores Available`
    return buildResult()
  }

  // 7. Indisponível — heartbeat ok mas conectores mistos
  correctedStatus = "unavailable"
  justification   = `Heartbeat ok, conectores: ${connectorStatuses.map(c=>`C${c.connectorId}=${c.status??'?'}`).join(", ")}`

  return buildResult()

  function buildResult() {
    return {
      stationID,
      totalLogs:           parsed.length,
      lastHeartbeatTs:     lastHbTs,
      heartbeatAgeMin:     lastHbTs ? Math.round(hbAgeMs/60000) : null,
      hasRecentHeartbeat:  hasRecentHb,
      connectorStatuses,
      hasActiveTransaction: activeTx.length > 0,
      activeTransactionIds: activeTx.map(t => t.txId),
      hasEnergyFlowing,
      finalPower,
      finalCurrent,
      finalEnergy,
      energyIncreasing,
      meterValuesCount:    meters.length,
      events,
      correctedStatus,
      justification,
      isInconsistent,
      reportedFaulted,
    }
  }
}

// ─── ANÁLISE EM LOTE ──────────────────────────────────────────────────────────

export async function analyzeUnavailableStations(stationList) {
  const targets = stationList.filter(s =>
    ["unavailable", "error", "offline"].includes(s.status)
  )

  console.log(`[analyzer] analisando ${targets.length} estações...`)
  const today = new Date().toISOString().split("T")[0]

  const results = []
  const BATCH = 5
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH)
    const batchResults = await Promise.all(
      batch.map(async s => {
        const logs     = await fetchOcppLogs(s.stationID, today)
        const analysis = analyzeOcppLogs(s.stationID, logs)
        return { ...analysis, name: s.name, originalStatus: s.status }
      })
    )
    results.push(...batchResults)
    console.log(`[analyzer] ${i + batch.length}/${targets.length} analisadas`)
  }

  const falseUnavailable = results.filter(r =>
    r.originalStatus === "unavailable" && r.correctedStatus === "charging"
  )
  const inconsistencies = results.filter(r => r.isInconsistent)
  const summary = {
    total:            results.length,
    falseUnavailable: falseUnavailable.length,
    inconsistencies:  inconsistencies.length,
    byStatus:         results.reduce((acc, r) => {
      acc[r.correctedStatus] = (acc[r.correctedStatus] ?? 0) + 1
      return acc
    }, {}),
  }

  console.log(`[analyzer] concluído:`, summary)
  return { summary, results, falseUnavailable, inconsistencies }
}