// Migração de tupi_logs.py
// Analisa logs OCPP a partir dos dados já disponíveis no /proxy-ocpp/api/stations
// Para logs em texto livre, usa parseLogText()

const LOG_ATENCAO_MS = 4 * 60 * 60 * 1000
const LOG_CRITICO_MS = 8 * 60 * 60 * 1000

// ─── ANÁLISE ESTRUTURAL (dados do proxy-ocpp) ─────────────────────────────────

/**
 * Analisa conectores e heartbeat vindos do /proxy-ocpp/api/stations.
 * Replica calcular_tempo_sem_log() + lógica de congelamento do tupi_logs.py.
 */
export function analyzeStationLogs(stationID, connectors, lastHeartbeat) {
  const now = Date.now()
  const signals = []

  const lastTs = lastHeartbeat ? new Date(lastHeartbeat).getTime() : null
  const logAge = lastTs ? now - lastTs : Infinity

  // Replica calcular_tempo_sem_log()
  let logStatus = "OK"
  if (!lastTs) {
    logStatus = "NUNCA_TEVE_LOG"
  } else if (logAge > LOG_CRITICO_MS) {
    logStatus = "CRITICO"
    signals.push({ type: "POSSIVEL_CONGELAMENTO", tipoErro: "CRITICO" })
  } else if (logAge > LOG_ATENCAO_MS) {
    logStatus = "ATENCAO_LONGO"
  }

  // Conectores com falha
  if (connectors?.length) {
    const faulted = connectors.filter(c => ["Faulted", "Unavailable"].includes(c.lastStatus))
    if (faulted.length > 0) {
      signals.push({
        type: "CONNECTOR_FAULT",
        tipoErro: "CRITICO",
        connector: faulted.map(c => c.connectorId).join(","),
      })
    }

    // Congelamento de status: todos os conectores sem mudança há > 15min
    const frozen15 = now - 15 * 60 * 1000
    const allFrozen = connectors.every(c =>
      c.lastStatusTimestamp && new Date(c.lastStatusTimestamp).getTime() < frozen15
    )
    if (allFrozen && connectors.length > 0) {
      signals.push({ type: "CONNECTOR_STATUS_FROZEN", tipoErro: "CRITICO" })
    }
  }

  return { signals, logAge, logStatus }
}

// ─── ANÁLISE DE TEXTO LIVRE (logs brutos OCPP) ────────────────────────────────

/**
 * Processa texto bruto de logs OCPP.
 * Replica as 4 regex do tupi_logs.py + detecção de erros físicos via campo "info".
 *
 * REGRA DE PRIORIDADE:
 *   status="Faulted" + info="BoxDoorIsOpen" → PORTA_ABERTA sempre CRITICO,
 *   sobe para o topo independentemente de outros erros no mesmo log.
 */
export function parseLogText(rawText) {
  const signals = []

  // ── ERROS FÍSICOS via campo "info" (NOVO) ─────────────────────────────────
  // Captura blocos StatusNotification completos para correlacionar status + info
  // Exemplo: [2,"...","StatusNotification",{"connectorId":2,"errorCode":"OtherError",
  //           "info":"BoxDoorIsOpen","status":"Faulted","vendorErrorCode":"0,60,0,0"}]
  const statusNotifRegex = /"StatusNotification"\s*,\s*(\{[^}]+\})/g
  for (const match of rawText.matchAll(statusNotifRegex)) {
    const block = match[1]

    const info      = block.match(/"info"\s*:\s*"([^"]+)"/)?.[1]      ?? ""
    const status    = block.match(/"status"\s*:\s*"([^"]+)"/)?.[1]    ?? ""
    const connector = block.match(/"connectorId"\s*:\s*(\d+)/)?.[1]   ?? "?"

    // BoxDoorIsOpen — CRITICO com prioridade máxima
    if (info === "BoxDoorIsOpen") {
      signals.push({
        type:     "PORTA_ABERTA",
        tipoErro: "CRITICO",
        priority: true,
        connector,
        status,
      })
      continue
    }

    // Outros erros físicos conhecidos — extensível sem alterar lógica existente
    const INFO_MAP = {
      "HighTemperature":     { type: "ALTA_TEMPERATURA",    tipoErro: "CRITICO" },
      "GroundFailure":       { type: "FALHA_ATERRAMENTO",   tipoErro: "CRITICO" },
      "OverCurrentFailure":  { type: "SOBRE_CORRENTE",      tipoErro: "CRITICO" },
      "ConnectorLockFailure":{ type: "FALHA_TRAVA",         tipoErro: "ERRO"    },
      "EVCommunicationError":{ type: "ERRO_COM_VEICULO",    tipoErro: "ERRO"    },
      "WeakSignal":          { type: "SINAL_FRACO",         tipoErro: "ALERTA"  },
    }
    if (INFO_MAP[info]) {
      signals.push({ ...INFO_MAP[info], connector, status })
    }
  }

  // ── LÓGICA ORIGINAL (inalterada) ──────────────────────────────────────────

  // 1. vendorErrorCode ≠ 0 (replica regex_vendor)
  for (const m of rawText.matchAll(/"vendorErrorCode"\s*:\s*"([^"]+)"/g)) {
    const partes = m[1].split(",").map(p => p.trim()).filter(Boolean)
    if (!partes.every(p => p === "0")) {
      signals.push({ type: "VENDOR_ERROR_CODE", tipoErro: "ERRO", value: m[1] })
    }
  }

  // 2. EmergencyStop (replica regex_info — campo isolado fora de StatusNotification)
  if (/"info"\s*:\s*"EmergencyStop"/i.test(rawText)) {
    signals.push({ type: "EMERGENCY_STOP", tipoErro: "CRITICO" })
  }

  // 3. Disconnect 1006 (replica regex_disconnect_1006)
  const disc = rawText.match(
    /"DisconnectNotification"[\s\S]*?"code"\s*:\s*1006[\s\S]*?"reason"\s*:\s*"([^"]*)"/
  )
  if (disc) {
    signals.push({ type: "DISCONNECT_1006", tipoErro: "QUEDA_CONEXAO", reason: disc[1] || "sem motivo" })
  }

  // 4. FirmwareVersion (replica regex_firmware — informativo)
  const fw = rawText.match(/"firmwareVersion"\s*:\s*"([^"]+)"/)
  if (fw) signals.push({ type: "FIRMWARE", tipoErro: "INFO", value: fw[1] })

  // Prioridade: PORTA_ABERTA e outros CRITICO com priority=true sobem ao topo
  signals.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0))

  return signals
}

/**
 * Converte signals[] no formato de tabela do tupi_logs.py:
 *   { Estacao, Erro, Quantidade, Tipo_Erro }
 *
 * Exemplo:
 *   { Estacao:"CPZON52", Erro:"PORTA_ABERTA", Quantidade:3, Tipo_Erro:"CRITICO" }
 */
export function signalsToTableRows(stationID, signals) {
  const counter = {}
  for (const s of signals) {
    if (!counter[s.type]) {
      counter[s.type] = { Estacao: stationID, Erro: s.type, Quantidade: 0, Tipo_Erro: s.tipoErro ?? "ERRO" }
    }
    counter[s.type].Quantidade++
  }

  const ORDEM = { CRITICO: 0, QUEDA_CONEXAO: 1, ERRO: 2, ALERTA: 3, INFO: 4 }
  return Object.values(counter)
    .sort((a, b) => (ORDEM[a.Tipo_Erro] ?? 5) - (ORDEM[b.Tipo_Erro] ?? 5))
}