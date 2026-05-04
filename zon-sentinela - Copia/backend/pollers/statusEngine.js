// backend/statusEngine.js
export const MANUAL_MAINTENANCES = {
  CPZON03: { since: new Date("2026-04-07T00:00:00") },
  CPZON32: { since: new Date("2026-02-21T00:00:00") },
  CPZON31: { since: new Date("2026-04-17T00:00:00") },
}

const T = {
  HEARTBEAT_OFFLINE_MS:   5  * 60 * 1000,
  STATUS_FROZEN_MS:       6  * 60 * 1000,
  LOG_CRITICO_MS:         8  * 60 * 60 * 1000,
  IDLE_NO_TX_MS:          4  * 60 * 60 * 1000,
  SILENT_ERROR_MIN_SCORE: 3,
  INACTIVE_THRESHOLD_MS:  20 * 24 * 60 * 60 * 1000,
}

export function isInactiveStation(raw) {
  if (MANUAL_MAINTENANCES[raw.stationID]) return false
  if (raw.operationStartedAt) return false
  const hbAge = raw.lastHeartbeat ? Date.now() - raw.lastHeartbeat : Infinity
  return hbAge > T.INACTIVE_THRESHOLD_MS
}

function silentScore(data) {
  const now = Date.now()
  let score = 0
  const reasons = []

  if (data.lastHeartbeat && (now - data.lastHeartbeat) > T.STATUS_FROZEN_MS)
    { score += 2; reasons.push("status_congelado") }
  if (data.lastConnectorChange && (now - data.lastConnectorChange) > T.STATUS_FROZEN_MS)
    { score += 1; reasons.push("connector_status_frozen") }
  if (data.activeTxMeterFrozen)
    { score += 3; reasons.push("meter_values_frozen") }
  if (data.abortRate > 0.5 && data.recentTxCount >= 3)
    { score += 2; reasons.push("high_abort_rate") }
  if (data.remoteStartRejected)
    { score += 3; reasons.push("remote_start_rejected") }
  if (data.zeroPeakHour)
    { score += 1; reasons.push("zero_tx_peak") }
  if ((data.disconnect1006Count ?? 0) > 3)
    { score += 2; reasons.push("disconnect_1006_repeated") }
  if (data.emergencyStop)
    { score += 5; reasons.push("emergency_stop") }
  if (data.portaAberta)
    { score += 5; reasons.push("porta_aberta") }

  return { score, reasons }
}

export function classify(raw) {
  const now = Date.now()

  if (!raw.inConnectedStations && !raw.operationStartedAt) return null

  const mm = MANUAL_MAINTENANCES[raw.stationID]
  if (mm) return {
    status: "maintenance",
    statusSince: mm.since.getTime(),
    silentScore: 0,
    silentReasons: [],
    maintenanceConfirmed: true,
  }

  const hbAge = raw.lastHeartbeat ? now - raw.lastHeartbeat : Infinity
  if (hbAge > T.HEARTBEAT_OFFLINE_MS) return {
    status: "offline",
    statusSince: raw.lastHeartbeat ?? now - hbAge,
    silentScore: 0,
    silentReasons: [],
  }

  if (raw.allConnectorsFaulted) return {
    status: "error",
    statusSince: raw.lastConnectorChange ?? now,
    silentScore: 0,
    silentReasons: ["all_connectors_faulted"],
  }

  const { score, reasons } = silentScore(raw)
  if (score >= T.SILENT_ERROR_MIN_SCORE) return {
    status: "error",
    statusSince: now,
    silentScore: score,
    silentReasons: reasons,
  }

  if ((raw.logAge ?? 0) > T.LOG_CRITICO_MS) return {
    status: "error",
    statusSince: now - raw.logAge,
    silentScore: score + 2,
    silentReasons: [...reasons, "log_timeout_critico"],
  }

  const txAge = raw.lastTx ? now - raw.lastTx : Infinity
  if (txAge > T.IDLE_NO_TX_MS && raw.connectorsAvailable) return {
    status: "unavailable",
    statusSince: raw.lastTx ?? now - txAge,
    silentScore: score,
    silentReasons: reasons,
  }

  return {
    status: "operational",
    statusSince: raw.lastHeartbeat ?? now,
    silentScore: 0,
    silentReasons: [],
  }
}

// Assinatura: buildStationList(connected[], nameMap, ocppMap, bffTxMap, ocppTxMap)
// connected  = array retornado por fetchConnectedStations()
// nameMap    = mapa stationID → nome
// ocppMap    = mapa stationID → dados OCPP (heartbeat, conectores)
// bffTxMap   = mapa stationID → última tx BFF (pode ser {} se não disponível)
// ocppTxMap  = mapa stationID → tx OCPP ativa
export function buildStationList(connected, nameMap, ocppMap, bffTxMap, ocppTxMap) {
  // Garante que bffTxMap e ocppTxMap são objetos (nunca undefined)
  const safeBff  = bffTxMap  ?? {}
  const safeOcpp = ocppTxMap ?? {}

  return connected.map(s => {
    const sid  = s.stationID
    const name = nameMap[sid] ?? s.name ?? sid
    const ocpp = ocppMap[sid]    ?? null
    const tx   = safeBff[sid]   ?? null
    const atx  = safeOcpp[sid]  ?? null
    const now  = Date.now()

    const lastHeartbeat = ocpp?.lastHeartbeat
      ? new Date(ocpp.lastHeartbeat).getTime() : null

    const connectors = ocpp?.connectors ?? []
    const allFaulted = connectors.length > 0 &&
      connectors.every(c => ["Faulted", "Unavailable"].includes(c.lastStatus))
    const allAvailable = connectors.every(c => c.lastStatus === "Available")

    const lastConnectorChange = connectors.length > 0
      ? Math.max(...connectors.map(c =>
          c.lastStatusTimestamp ? new Date(c.lastStatusTimestamp).getTime() : 0))
      : null

    const lastTxBff  = tx?.startDateTime   ? new Date(tx.startDateTime).getTime()   : null
    const lastTxOcpp = atx?.startTimestamp ? new Date(atx.startTimestamp).getTime() : null
    const lastTx     = lastTxBff ?? lastTxOcpp ?? null

    const activeTxMeterFrozen = tx?.status === "active" &&
      (tx.meterValues?.chargedEnergy === 0 || tx.energyValue === 0)

    const raw = {
      stationID:            sid,
      name,
      inConnectedStations:  true,
      operationStartedAt:   s.operationStartedAt,
      lastHeartbeat,
      lastConnectorChange,
      allConnectorsFaulted: allFaulted,
      connectorsAvailable:  allAvailable,
      connectors,
      lastTx,
      activeTxMeterFrozen,
      abortRate:            0,
      recentTxCount:        0,
      remoteStartRejected:  false,
      zeroPeakHour:         false,
      disconnect1006Count:  0,
      emergencyStop:        false,
      portaAberta:          false,
      logAge:               0,
      logStatus:            "OK",
      logSignals:           [],
      totalCargas:          0,
      bemSucedidas:         0,
      zeradas:              0,
      energiaTotal:         0,
      taxaSucesso:          0,
      mediaKwh:             0,
      power:                s.power,
      current:              s.current,
      firmware:             ocpp?.firmwareVersion    ?? null,
      vendor:               ocpp?.chargePointVendor  ?? null,
      model:                ocpp?.chargePointModel   ?? null,
    }

    const classification = classify(raw) ?? {
      status:       "unknown",
      statusSince:  now,
      silentScore:  0,
      silentReasons:[],
    }

    return { ...raw, ...classification }
  })
}