// backend/debug_energia.js
// Rode: node debug_energia.js
// Mostra a estrutura real das transações para diagnosticar o campo de energia
import "dotenv/config"
import { ensureAuth, bffPost } from "./tupiClient.js"

await ensureAuth()

const now      = new Date()
const startDay = new Date(now)
startDay.setUTCHours(3, 0, 0, 0)  // 00:00 BRT = 03:00 UTC
if (startDay > now) startDay.setUTCDate(startDay.getUTCDate() - 1)

const data = await bffPost("/chargerHistory", {
  page: 1, limit: 5, show_zero_charges: true,
  startDate: startDay.toISOString(),
  endDate:   now.toISOString(),
})

console.log("=== ESTRUTURA DE 5 TRANSAÇÕES ===\n")
for (const tx of data.docs ?? []) {
  console.log({
    stationID:       tx.stationID,
    status:          tx.status,
    // todos os campos candidatos de energia
    chargedEnergy:   tx.chargedEnergy,
    energyValue:     tx.energyValue,
    meterStop:       tx.meterStop,
    energy:          tx.energy,
    "meterValues.chargedEnergy": tx.meterValues?.chargedEnergy,
    chargeFeesTotal: tx.chargeFeesTotal,
    // datas
    startDateTime:   tx.startDateTime,
    stopDateTime:    tx.stopDateTime,
  })
  console.log("--- raw keys:", Object.keys(tx).join(", "))
  console.log("")
}