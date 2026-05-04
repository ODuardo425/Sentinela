import "dotenv/config"

const BFF_BASE     = "https://tupi-backend-bff.tupinrg.app"
const FIREBASE_KEY = "AIzaSyCjNbUpyHihJuIkMBU7Qoiq0r1E7-_QrbI"

let _token          = null
let _tokenExpiresAt = 0

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function getFirebaseToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email:             process.env.TUPI_EMAIL,
        password:          process.env.TUPI_PASSWORD,
        returnSecureToken: true,
      }),
    }
  )
  if (!res.ok) throw new Error(`Firebase auth failed: ${res.status}`)
  const { idToken } = await res.json()
  return idToken
}

async function getCustomToken(firebaseIdToken) {
  // Passo 1: obtém customToken da Tupi
  const r1 = await fetch(`${BFF_BASE}/auth/custom-token`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${firebaseIdToken}`,
    },
  })
  if (!r1.ok) throw new Error(`Custom token failed: ${r1.status}`)
  const { customToken } = await r1.json()

  // Passo 2: troca customToken por idToken via Firebase signInWithCustomToken
  const r2 = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${FIREBASE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  )
  if (!r2.ok) throw new Error(`signInWithCustomToken failed: ${r2.status}`)
  const { idToken } = await r2.json()
  return idToken
}

export async function ensureAuth() {
  if (_token && Date.now() < _tokenExpiresAt) return
  console.log("[auth] obtendo token...")
  const firebaseToken = await getFirebaseToken()
  _token = await getCustomToken(firebaseToken)
  _tokenExpiresAt = Date.now() + 55 * 60 * 1000
  console.log("[auth] token renovado, expira em 55min")
}

// ─── HTTP BASE ────────────────────────────────────────────────────────────────

async function request(path, opts = {}) {
  if (!_token) throw new Error("Not authenticated")
  const sep = path.includes("?") ? "&" : "?"
  const url = `${BFF_BASE}${path}${sep}tupi_cache_purge=${Date.now()}`
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${_token}`,
      ...(opts.headers ?? {}),
    },
  })
  if (res.status === 401) {
    _token = null
    throw new Error("Token expired")
  }
  if (!res.ok) throw new Error(`BFF ${path} → ${res.status}`)
  return res.json()
}

export async function bffGet(path)         { return request(path, { method: "GET" }) }
export async function bffPost(path, body)  { return request(path, { method: "POST", body: JSON.stringify(body) }) }

// ─── PAGINAÇÃO COMPLETA ───────────────────────────────────────────────────────

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

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

export async function fetchConnectedStations() {
  return fetchAllPages("/connected_stations", (page) => ({ page, limit: 100 }))
}

export async function fetchStationNameMap() {
  const data = await bffGet("/select/connected_stations")
  const arr  = Array.isArray(data) ? data : data.docs ?? []
  const map  = {}
  arr.forEach(s => { if (s.stationID) map[s.stationID] = s.name ?? s.stationID })
  return map
}

export async function fetchOcppStations() {
  const data = await bffGet("/proxy-ocpp/api/stations")
  const arr  = Array.isArray(data) ? data : data.docs ?? []
  const map  = {}
  arr.forEach(s => { map[s.stationId] = s })
  return map
}

export async function fetchOcppTransactions() {
  const data = await bffGet("/proxy-ocpp/api/transactions")
  const arr  = data.docs ?? []
  const map  = {}
  arr.forEach(tx => {
    const sid = tx.stationId
    if (!map[sid] || tx.startTimestamp > map[sid].startTimestamp) map[sid] = tx
  })
  return map
}

export async function fetchChargeHistory(horasAtras = 24) {
  const now        = new Date()
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const from      = new Date(now - horasAtras * 3600 * 1000)
  const startDate = startOfDay < from ? startOfDay : from

  return fetchAllPages("/chargerHistory", (page) => ({
    page,
    limit:             100,
    show_zero_charges: true,
    startDate:         startDate.toISOString(),
    endDate:           now.toISOString(),
  }))
}