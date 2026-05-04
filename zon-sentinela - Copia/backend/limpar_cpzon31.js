// backend/limpar_cpzon31.js
// Execute UMA VEZ: node limpar_cpzon31.js
// Remove CPZON31 das manutenções dinâmicas e a marca como fixa encerrada
import "dotenv/config"
import Redis from "ioredis"

const kv = new Redis(process.env.REDIS_URL)

const MANUT_KEY      = "manutencoes:dinamicas"
const FIXED_ENDED    = "manutencoes:fixas:encerradas"

// Remove CPZON31 das dinâmicas
const manutRaw  = await kv.get(MANUT_KEY)
const manutList = manutRaw ? JSON.parse(manutRaw) : []
const filtrada  = manutList.filter(m => m.stationID !== "CPZON31")
await kv.set(MANUT_KEY, JSON.stringify(filtrada))
console.log(`Dinâmicas: removido CPZON31. Restam: ${filtrada.length}`)

// Garante que CPZON31 está na lista de fixas encerradas
const endedRaw  = await kv.get(FIXED_ENDED)
const endedList = endedRaw ? JSON.parse(endedRaw) : []
if (!endedList.includes("CPZON31")) endedList.push("CPZON31")
await kv.set(FIXED_ENDED, JSON.stringify(endedList))
console.log(`Fixas encerradas: ${endedList.join(", ")}`)

await kv.del("stations:cache")
console.log("Cache limpo. Reinicie o backend.")
await kv.quit()