// Migração de apitupi.py
// Consulta https://api.tupinambaenergia.com.br/station/{stationID}
// Endpoint público — sem autenticação necessária
// Retorna stateName: Available | Charging | Occupied | Faulted | Unavailable

const STATION_API_BASE = "https://api.tupinambaenergia.com.br/station"

/**
 * Mapeia stateName para código — replica mapear_status_para_codigo() do apitupi.py
 * 0  = Disponível
 * 1  = Carregando/Ocupado
 * -1 = Faulted/Erro/Indisponível
 */
function mapStatus(stateName) {
  if (!stateName) return { code: -1, text: "Status Nulo" }
  const s = stateName.toLowerCase()
  if (s === "available")                return { code: 0,  text: "Disponível"        }
  if (s === "charging" || s === "occupied") return { code: 1,  text: "Carregando/Ocupado" }
  return { code: -1, text: stateName }
}

/**
 * Busca o stateName de uma estação pelo endpoint público.
 * Replica obter_status_estacao() do apitupi.py.
 */
async function fetchStationStatus(stationID) {
  try {
    const res = await fetch(`${STATION_API_BASE}/${stationID}`, {
      signal: AbortSignal.timeout(10000), // 10s timeout
    })
    if (!res.ok) return { code: -1, text: `HTTP ${res.status}` }
    const data = await res.json()
    return mapStatus(data.stateName)
  } catch {
    return { code: -1, text: "Erro na Coleta" }
  }
}

/**
 * Consulta todas as estações da lista em paralelo (lotes de 10 para não sobrecarregar).
 * @param {string[]} stationIDs  — lista de IDs ex: ["CPZON01","CPZON02",...]
 * @returns {Object}  stationID → { code, text, available, charging, faulted }
 */
export async function fetchAllStationAvailability(stationIDs) {
  const results = {}
  const BATCH = 10

  for (let i = 0; i < stationIDs.length; i += BATCH) {
    const batch = stationIDs.slice(i, i + BATCH)
    const entries = await Promise.all(
      batch.map(async id => {
        const status = await fetchStationStatus(id)
        return [id, {
          ...status,
          available: status.code === 0,
          charging:  status.code === 1,
          faulted:   status.code === -1,
          ts:        Date.now(),
        }]
      })
    )
    entries.forEach(([id, val]) => { results[id] = val })
  }

  return results
}

/**
 * Retorna resumo de disponibilidade para o dashboard.
 * @param {Object} availMap  — resultado de fetchAllStationAvailability()
 */
export function summarizeAvailability(availMap) {
  const vals = Object.values(availMap)
  return {
    total:     vals.length,
    available: vals.filter(v => v.available).length,
    charging:  vals.filter(v => v.charging).length,
    faulted:   vals.filter(v => v.faulted).length,
    rate:      vals.length > 0
      ? parseFloat(((vals.filter(v => v.available || v.charging).length / vals.length) * 100).toFixed(1))
      : 0,
  }
}