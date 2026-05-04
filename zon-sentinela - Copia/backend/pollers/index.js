// backend/pollers/index.js
import { fetchChargeStats }            from "./chargeHistoryPoller.js"
import { analyzeStationLogs }          from "./logPoller.js"
import { fetchAllStationAvailability } from "./stationApiPoller.js"

export async function enrichWithPollers(stationList) {
  const stationIDs = stationList.map(s => s.stationID)

  // Executa em paralelo: cargas do dia + disponibilidade API pública
  const [chargeStats, availMap] = await Promise.all([
    fetchChargeStats().catch(e => { console.warn("[enricher] chargeStats falhou:", e.message); return {} }),
    fetchAllStationAvailability(stationIDs).catch(e => { console.warn("[enricher] availMap falhou:", e.message); return {} }),
  ])

  return stationList.map(s => {
    const cs    = chargeStats[s.stationID] ?? {}
    const avail = availMap[s.stationID]    ?? { code: -1, text: "—", available: false, charging: false, faulted: false }

    // Log analysis — usa dados já disponíveis nos conectores (sem fetch extra)
    const logAnalysis = analyzeStationLogs(
      s.stationID,
      s.connectors ?? [],
      s.lastHeartbeat ? new Date(s.lastHeartbeat).toISOString() : null
    )

    return {
      ...s,

      // ── Dados de carga ────────────────────────────────────────────────────
      totalCargas:         cs.totalCargas        ?? 0,
      bemSucedidas:        cs.bemSucedidas        ?? 0,
      zeradas:             cs.zeradas             ?? 0,
      energiaTotal:        cs.energiaTotal        ?? 0,
      taxaSucesso:         cs.taxaSucesso         ?? 0,
      mediaKwh:            cs.mediaKwhPorRecarga  ?? 0,
      abortRate:           cs.abortRate           ?? 0,
      recentTxCount:       cs.recentTxCount       ?? 0,
      lastTx:              cs.lastTx              ?? s.lastTx,
      activeTxMeterFrozen: cs.activeTxMeterFrozen ?? false,
      clientesUnicos:      cs.clientesUnicos      ?? 0,
      receitaDia:          cs.receitaDia          ?? 0,
      horarioPico:         cs.horarioPico         ?? null,
      connectorMaisUsado:  cs.connectorMaisUsado  ?? null,
      ultimaCarga:         cs.ultimaCarga         ?? null,
      usuariosZeradas:     cs.usuariosZeradas      ?? [],

      // ── Dados de log ──────────────────────────────────────────────────────
      logAge:              logAnalysis.logAge,
      logStatus:           logAnalysis.logStatus,
      logSignals:          logAnalysis.signals,
      disconnect1006Count: logAnalysis.signals.filter(x => x?.type === "DISCONNECT_1006").length,
      emergencyStop:       logAnalysis.signals.some(x => x?.type === "EMERGENCY_STOP"),
      portaAberta:         logAnalysis.signals.some(x => x?.type === "PORTA_ABERTA"),

      // ── API pública (apitupi.py) ──────────────────────────────────────────
      stationApiStatus:    avail.text,
      stationApiCode:      avail.code,
      stationApiAvailable: avail.available,
      stationApiCharging:  avail.charging,
      stationApiFaulted:   avail.faulted,
      stationApiTs:        avail.ts,
    }
  })
}