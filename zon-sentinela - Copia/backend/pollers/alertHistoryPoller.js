// backend/pollers/alertHistoryPoller.js
// Registra histórico de alertas e erros por estação no Redis.
// Baseado na lógica do tupi_logs.py mas usando dados já coletados via API
// (sem Selenium), enriquecido com sinais OCPP do logPoller.

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000
const ALERT_KEY_TTL = 35 * 86400  // 35 dias

// Tipos de alerta com prioridade e label
const ALERT_TYPES = {
  PORTA_ABERTA:          { label: "Porta de gabinete aberta",      priority: 1, color: "red",    icon: "🚪" },
  EMERGENCY_STOP:        { label: "Emergency Stop",                priority: 1, color: "red",    icon: "🛑" },
  OFFLINE_CRITICO:       { label: "Offline há mais de 24h",        priority: 1, color: "red",    icon: "📡" },
  OFFLINE:               { label: "Offline",                       priority: 2, color: "red",    icon: "🔴" },
  DISCONNECT_1006:       { label: "Queda de conexão (1006)",       priority: 2, color: "orange", icon: "🔌" },
  ERRO_SILENCIOSO:       { label: "Falha silenciosa detectada",    priority: 2, color: "orange", icon: "⚠" },
  CONNECTOR_FAULT:       { label: "Conector com falha",            priority: 2, color: "orange", icon: "⚡" },
  METER_FROZEN:          { label: "Medidor congelado em sessão",   priority: 3, color: "yellow", icon: "🧊" },
  HIGH_ABORT:            { label: "Alta taxa de cargas zeradas",   priority: 3, color: "yellow", icon: "📉" },
  POSSIVEL_CONGELAMENTO: { label: "Possível congelamento de log",  priority: 3, color: "yellow", icon: "❄" },
  INDISPONIVEL:          { label: "Indisponível (sem transação)",  priority: 4, color: "yellow", icon: "⏸" },
}

function todayBRT() {
  const d = new Date(Date.now() - BRT_OFFSET_MS)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`
}

function datesBRT(dias) {
  const dates = []
  for (let i = 0; i < dias; i++) {
    const d = new Date(Date.now() - BRT_OFFSET_MS - i * 86400000)
    dates.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`)
  }
  return dates
}

/**
 * Detecta alertas ativos de uma estação a partir dos dados já enriquecidos.
 * Replica a lógica do tupi_logs.py mas via API em vez de Selenium.
 */
function detectAlerts(s) {
  const alerts = []
  const now    = Date.now()

  // 1. Porta aberta — máxima prioridade
  if (s.portaAberta)
    alerts.push({ type: "PORTA_ABERTA", detail: "BoxDoorIsOpen detectado" })

  // 2. Emergency Stop
  if (s.emergencyStop)
    alerts.push({ type: "EMERGENCY_STOP", detail: "Sinal EmergencyStop nos logs OCPP" })

  // 3. Offline crítico (>24h)
  if (s.status === "offline" && s.statusSince && (now - s.statusSince) > 86400000)
    alerts.push({ type: "OFFLINE_CRITICO", detail: `Offline há ${Math.floor((now-s.statusSince)/3600000)}h` })

  // 4. Offline normal
  else if (s.status === "offline")
    alerts.push({ type: "OFFLINE", detail: s.lastHeartbeat ? `Último HB: ${Math.floor((now-s.lastHeartbeat)/60000)}min atrás` : "Sem heartbeat" })

  // 5. Disconnect 1006
  if ((s.disconnect1006Count ?? 0) >= 1)
    alerts.push({ type: "DISCONNECT_1006", detail: `${s.disconnect1006Count} queda${s.disconnect1006Count>1?"s":""} detectada${s.disconnect1006Count>1?"s":""}` })

  // 6. Falha silenciosa
  if (s.status === "error" && s.silentScore >= 3)
    alerts.push({ type: "ERRO_SILENCIOSO", detail: `Score ${s.silentScore}: ${(s.silentReasons??[]).join(", ")}` })

  // 7. Conector com falha
  const faulted = (s.connectors??[]).filter(c => ["Faulted","Unavailable"].includes(c.lastStatus))
  if (faulted.length > 0 && s.status !== "offline")
    alerts.push({ type: "CONNECTOR_FAULT", detail: `C${faulted.map(c=>c.connectorId).join(",")} em ${faulted[0].lastStatus}` })

  // 8. Meter frozen em sessão ativa
  if (s.activeTxMeterFrozen)
    alerts.push({ type: "METER_FROZEN", detail: "Sessão ativa sem energia sendo medida" })

  // 9. Alta taxa de zeradas
  if (s.abortRate > 0.4 && s.recentTxCount >= 3)
    alerts.push({ type: "HIGH_ABORT", detail: `${Math.round(s.abortRate*100)}% de cargas zeradas (${s.recentTxCount} sessões)` })

  // 10. Possível congelamento de log
  if (s.logStatus === "CRITICO" || s.logStatus === "ATENCAO_LONGO")
    alerts.push({ type: "POSSIVEL_CONGELAMENTO", detail: `Status de log: ${s.logStatus}` })

  // 11. Indisponível
  if (s.status === "unavailable")
    alerts.push({ type: "INDISPONIVEL", detail: s.lastTx ? `Sem transação há ${Math.floor((now-s.lastTx)/3600000)}h` : "Nunca transacionou" })

  return alerts
}

/**
 * Salva snapshot de alertas de cada estação no Redis.
 * Chave: alerts:{stationID}:{YYYY-MM-DD} → array de eventos
 */
export async function saveAlertSnapshot(kv, stations) {
  const today = todayBRT()
  const ts    = Date.now()

  for (const s of stations) {
    const key    = `alerts:${s.stationID}:${today}`
    const alerts = detectAlerts(s)
    if (!alerts.length) continue

    try {
      const raw      = await kv.get(key)
      const existing = raw ? JSON.parse(raw) : []

      // Só adiciona se o tipo de alerta mudou desde o último snapshot
      const lastTypes = new Set(existing.length ? existing[existing.length-1].alerts.map(a=>a.type) : [])
      const newTypes  = new Set(alerts.map(a=>a.type))
      const changed   = [...newTypes].some(t => !lastTypes.has(t)) || [...lastTypes].some(t => !newTypes.has(t))

      if (changed || !existing.length) {
        existing.push({ ts, alerts })
        if (existing.length > 500) existing.splice(0, existing.length - 500)
        await kv.set(key, JSON.stringify(existing), "EX", ALERT_KEY_TTL)
      }
    } catch {}
  }
}

/**
 * Retorna histórico consolidado de alertas para todas as estações.
 * Resultado: { stationID → { name, status, alertsHoje: [], historico: [{date, tipos}] } }
 */
export async function getAlertHistory(kv, stations, dias = 7) {
  const dates      = datesBRT(dias)
  const stationMap = Object.fromEntries(stations.map(s => [s.stationID, s]))
  const result     = {}

  // Busca todos os alertas atuais das estações
  for (const s of stations) {
    const alertsNow = detectAlerts(s)
    if (!result[s.stationID]) {
      result[s.stationID] = {
        stationID:   s.stationID,
        name:        s.name,
        status:      s.status,
        alertsAgora: alertsNow,
        historico:   [],
        totalEventos: 0,
        tiposMaisFrequentes: {},
      }
    }
  }

  // Busca histórico do Redis para cada estação e data
  for (const s of stations) {
    const hist = []
    for (const date of dates.slice().reverse()) { // mais antigo primeiro
      const key = `alerts:${s.stationID}:${date}`
      try {
        const raw   = await kv.get(key)
        const snaps = raw ? JSON.parse(raw) : []

        // Consolida tipos únicos do dia
        const tiposDia = {}
        for (const snap of snaps) {
          for (const a of snap.alerts) {
            if (!tiposDia[a.type]) tiposDia[a.type] = { count: 0, detail: a.detail }
            tiposDia[a.type].count++
          }
        }
        hist.push({ date, eventos: Object.entries(tiposDia).map(([type, d]) => ({ type, ...d })) })

        // Acumula para ranking de tipos mais frequentes
        for (const [type, d] of Object.entries(tiposDia)) {
          result[s.stationID].tiposMaisFrequentes[type] =
            (result[s.stationID].tiposMaisFrequentes[type] ?? 0) + d.count
          result[s.stationID].totalEventos += d.count
        }
      } catch {
        hist.push({ date, eventos: [] })
      }
    }
    result[s.stationID].historico = hist
  }

  return result
}