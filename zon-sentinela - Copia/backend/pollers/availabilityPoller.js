// backend/pollers/availabilityPoller.js
import { bffGet } from "../tupiClient.js"

const BRT_OFFSET_MS = 3 * 60 * 60 * 1000
const SNAP_TTL      = 35 * 86400  // 35 dias

function nowBRTStr() {
  const d = new Date(Date.now() - BRT_OFFSET_MS)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`
}

function datesBRT(dias) {
  const out = []
  for (let i = 0; i < dias; i++) {
    const d = new Date(Date.now() - BRT_OFFSET_MS - i * 86400000)
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`)
  }
  return out
}

function midnightBRTms() {
  const brtMs = Date.now() - BRT_OFFSET_MS
  const d     = new Date(brtMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + BRT_OFFSET_MS
}

export function calcDisponibilidade(lastHeartbeat, statusSince, status) {
  const now      = Date.now()
  const midnight = midnightBRTms()
  const totalMs  = now - midnight
  if (totalMs <= 0) return 100

  let onlineMs
  if (["operational","unavailable","error"].includes(status)) {
    onlineMs = now - Math.max(statusSince ?? midnight, midnight)
  } else if (status === "offline") {
    onlineMs = Math.max(statusSince ?? midnight, midnight) - midnight
  } else if (status === "maintenance") {
    onlineMs = 0
  } else {
    onlineMs = totalMs * 0.5
  }

  return parseFloat((Math.max(0, Math.min(onlineMs, totalMs)) / totalMs * 100).toFixed(2))
}

/**
 * Salva snapshot enriquecido no Redis a cada 30s.
 * Inclui: status, disponibilidade, disconnect1006Count, portaAberta, silentScore
 */
export async function saveAvailabilitySnapshot(kv, stations) {
  const today = nowBRTStr()
  for (const s of stations) {
    const key  = `avail:${s.stationID}:${today}`
    const snap = {
      ts:              Date.now(),
      status:          s.status,
      statusSince:     s.statusSince,
      lastHeartbeat:   s.lastHeartbeat,
      disponibilidade: calcDisponibilidade(s.lastHeartbeat, s.statusSince, s.status),
      disc1006:        s.disconnect1006Count ?? 0,
      portaAberta:     s.portaAberta         ?? false,
      silentScore:     s.silentScore          ?? 0,
      emergencyStop:   s.emergencyStop        ?? false,
    }
    try {
      const raw = await kv.get(key)
      const arr = raw ? JSON.parse(raw) : []
      arr.push(snap)
      if (arr.length > 2880) arr.splice(0, arr.length - 2880) // máx 24h × 2/min
      await kv.set(key, JSON.stringify(arr), "EX", SNAP_TTL)
    } catch {}
  }
}

/**
 * Reconstrói períodos offline do dia a partir dos snapshots.
 * Retorna lista de { inicio, fim, duracaoMin }
 */
function extractOfflinePeriods(snaps) {
  const periods = []
  let offlineStart = null

  for (const snap of snaps) {
    if (snap.status === "offline" && !offlineStart) {
      offlineStart = snap.ts
    } else if (snap.status !== "offline" && offlineStart) {
      periods.push({
        inicio:      offlineStart,
        fim:         snap.ts,
        duracaoMin:  Math.round((snap.ts - offlineStart) / 60000),
      })
      offlineStart = null
    }
  }
  // Ainda offline ao final
  if (offlineStart) {
    periods.push({
      inicio:     offlineStart,
      fim:        null,
      duracaoMin: Math.round((Date.now() - offlineStart) / 60000),
    })
  }
  return periods
}

/**
 * Processa snapshots de um dia em métricas consolidadas.
 */
function processDay(snaps, date) {
  if (!snaps.length) return { date, disponibilidade: null, minOffline: null, quedas: null, disc1006: null, offlinePeriods: [] }

  const dispMedia = snaps.reduce((a,s) => a + (s.disponibilidade ?? 0), 0) / snaps.length

  let quedas = 0
  for (let i = 1; i < snaps.length; i++) {
    if (snaps[i].status === "offline" && snaps[i-1].status !== "offline") quedas++
  }

  const offlineSnaps = snaps.filter(s => s.status === "offline").length
  const minOffline   = Math.round((offlineSnaps / snaps.length) * 24 * 60)
  const disc1006     = Math.max(...snaps.map(s => s.disc1006 ?? 0))
  const periods      = extractOfflinePeriods(snaps)

  return {
    date,
    disponibilidade: parseFloat(dispMedia.toFixed(2)),
    minOffline,
    quedas,
    disc1006,
    offlinePeriods: periods,
    snaps,  // para o mini gráfico de barras
  }
}

/**
 * Retorna histórico de disponibilidade de uma estação por N dias.
 */
export async function getAvailabilityHistory(kv, stationID, dias = 7) {
  const dates = datesBRT(dias)
  const result = []
  for (const date of dates) {
    try {
      const raw   = await kv.get(`avail:${stationID}:${date}`)
      const snaps = raw ? JSON.parse(raw) : []
      result.push(processDay(snaps, date))
    } catch {
      result.push({ date, disponibilidade: null, minOffline: null, quedas: null, disc1006: null, offlinePeriods: [] })
    }
  }
  return result.reverse() // mais antigo primeiro
}

/**
 * Agrega disponibilidade de todas as estações.
 */
export async function getAllAvailability(kv, stations, dias = 7) {
  const result = {}
  await Promise.all(stations.map(async s => {
    const hist  = await getAvailabilityHistory(kv, s.stationID, dias)
    const valid = hist.filter(d => d.disponibilidade !== null)
    const media = valid.length
      ? parseFloat((valid.reduce((a,d) => a + d.disponibilidade, 0) / valid.length).toFixed(2))
      : calcDisponibilidade(s.lastHeartbeat, s.statusSince, s.status)
    const totalMinOffline = valid.reduce((a,d) => a + (d.minOffline ?? 0), 0)
    const totalQuedas     = valid.reduce((a,d) => a + (d.quedas ?? 0), 0)
    const totalDisc1006   = valid.reduce((a,d) => a + (d.disc1006 ?? 0), 0)

    // Snapshots das últimas 24h para mini gráfico timeline
    const todaySnaps = hist[hist.length - 1]?.snaps ?? []

    result[s.stationID] = {
      stationID:       s.stationID,
      name:            s.name,
      status:          s.status,
      disponibilidade: media,
      totalMinOffline,
      totalQuedas,
      totalDisc1006,
      lastHeartbeat:   s.lastHeartbeat,
      statusSince:     s.statusSince,
      vendor:          s.vendor ?? null,
      power:           s.power  ?? null,
      dias:            hist,
      todaySnaps,
    }
  }))
  return result
}