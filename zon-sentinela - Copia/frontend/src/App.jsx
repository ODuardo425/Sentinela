import { useState, useEffect, useCallback, useRef } from "react"

const API_BASE = ""

const MANUAL_MAINTENANCES = {
  CPZON03: { since: new Date("2026-04-07") },
  CPZON32: { since: new Date("2026-02-21") },
}

// ─── CORES ────────────────────────────────────────────────────────────────────
const C = {
  sidebar:      "#0f1e35",
  sidebarHover: "#1a2f4a",
  sidebarActive:"#1e3a5f",
  sidebarBorder:"rgba(255,255,255,0.07)",

  blue:         "#1a4fa0",
  blueMid:      "#2563eb",
  blueLight:    "#eff6ff",
  bluePale:     "#dbeafe",

  orange:       "#f47920",
  orangeLight:  "#fff4ed",
  orangePale:   "#ffe4cc",

  bg:           "#f0f2f5",
  white:        "#ffffff",
  text:         "#0f1e35",
  textMid:      "#374151",
  textLight:    "#6b7280",
  grayLight:    "#f3f4f6",
  grayBorder:   "#e5e7eb",

  green:        "#16a34a",
  greenLight:   "#f0fdf4",
  red:          "#dc2626",
  redLight:     "#fef2f2",
  yellow:       "#d97706",
  yellowLight:  "#fffbeb",
}

const STATUS = {
  operational: { label:"Operante",     dot:C.green,  bg:"#f0fdf4", border:"#bbf7d0", text:C.green  },
  offline:     { label:"Offline",      dot:C.red,    bg:"#fef2f2", border:"#fecaca", text:C.red    },
  error:       { label:"Em erro",      dot:C.orange, bg:"#fff4ed", border:"#fed7aa", text:C.orange },
  maintenance: { label:"Manutenção",   dot:C.blue,   bg:"#eff6ff", border:"#bfdbfe", text:C.blue   },
  unavailable: { label:"Indisponível", dot:C.yellow, bg:"#fffbeb", border:"#fde68a", text:C.yellow },
  unknown:     { label:"Desconhecido", dot:C.textLight, bg:C.grayLight, border:C.grayBorder, text:C.textLight },
}

const SILENT_LABEL = {
  status_congelado:         "Status congelado",
  connector_status_frozen:  "Conector congelado",
  meter_values_frozen:      "Meter frozen",
  high_abort_rate:          "Alto abort rate",
  remote_start_rejected:    "RemoteStart rejeitado",
  zero_tx_peak:             "Sem tx no pico",
  log_timeout_critico:      "Log timeout",
  disconnect_1006_repeated: "Disconnect 1006",
  emergency_stop:           "EmergencyStop",
  all_connectors_faulted:   "Conectores faulted",
  porta_aberta:             "PORTA ABERTA",
}

const TABS = [
  { id:"dashboard",   label:"Dashboard",     icon:"⊞" },
  { id:"stations",    label:"Estações",      icon:"⚡" },
  { id:"alerts",      label:"Alertas",       icon:"🔔" },
  { id:"charges",     label:"Cargas",        icon:"📊" },
  { id:"availability",label:"Disponibilidade",icon:"📶"},
  { id:"maintenance", label:"Manutenções",   icon:"🔧" },
  { id:"map",         label:"Mapa",          icon:"🗺"  },
]

const MARCAS = [
  { label:"Todas",  match:null },
  { label:"Beny",   match:["beny","zjbeny"] },
  { label:"Riseon", match:["sino","riseon","rise-on"] },
  { label:"Teison", match:["tengning","teison","tei-son"] },
]

function matchMarca(vendor, marcaMatch) {
  if (!marcaMatch) return true
  if (!vendor) return false
  const v = vendor.toLowerCase()
  return marcaMatch.some(m => v.includes(m))
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function dur(ms) {
  if (!ms || ms <= 0) return "—"
  const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24)
  if(d>0) return `${d}d ${h%24}h`
  if(h>0) return `${h}h ${m%60}m`
  if(m>0) return `${m}m`
  return `${s}s`
}
function ago(ts){ return ts?dur(Date.now()-ts)+" atrás":"—" }
function fmtDate(ts){ return new Date(ts).toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric"}) }
function fmtTime(ts){ return new Date(ts).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",second:"2-digit"}) }

// ─── LOGO ZON CHARGE (original com barras) ────────────────────────────────────
function ZonLogo({ size=40 }) {
  return (
    <svg width={size*2.5} height={size} viewBox="0 0 250 100" fill="none">
      <text x="0" y="72" fontFamily="'Arial Black',Arial,sans-serif"
        fontWeight="900" fontSize="78" letterSpacing="-3" fill="white">ZON</text>
      <circle cx="122" cy="41" r="19" stroke="white" strokeWidth="6" fill="none"/>
      <text x="2" y="96" fontFamily="'Arial Black',Arial,sans-serif"
        fontWeight="900" fontSize="21" letterSpacing="8" fill="white">CHARGE</text>
      {[150,156,162,168,174,180,186,192,198,204,210,216,222,228,234].map((x,i)=>(
        <rect key={x} x={x} y={80} width="3"
          height={Math.max(3, 18 - i*1.2)} fill="white"/>
      ))}
    </svg>
  )
}

// ─── SSE HOOK ─────────────────────────────────────────────────────────────────
function useStations() {
  const [stations,setStations]     = useState([])
  const [connected,setConnected]   = useState(false)
  const [source,setSource]         = useState("connecting")
  const [lastUpdate,setLastUpdate] = useState(null)

  const applyMaintenance = useCallback((list) =>
    list.map(s => {
      const mm = MANUAL_MAINTENANCES[s.stationID]
      if(mm) return {...s, status:"maintenance", statusSince:mm.since.getTime()}
      return s
    }),[])

  useEffect(()=>{
    let es=null, timer=null
    function connectSSE(){
      try {
        es = new EventSource(`${API_BASE}/api/stream`)
        es.addEventListener("snapshot", e => {
          setStations(applyMaintenance(JSON.parse(e.data)))
          setConnected(true); setSource("sse"); setLastUpdate(new Date())
        })
        es.addEventListener("update", e => {
          const upd = JSON.parse(e.data)
          setStations(prev => applyMaintenance(prev.map(s => s.stationID===upd.stationID?{...s,...upd}:s)))
          setLastUpdate(new Date())
        })
        es.onerror = () => { setConnected(false); setSource("poll"); es?.close(); timer=setTimeout(pollFallback,5000) }
      } catch { timer=setTimeout(pollFallback,5000) }
    }
    async function pollFallback(){
      try {
        const r = await fetch(`${API_BASE}/api/stations`)
        setStations(applyMaintenance(await r.json()))
        setConnected(true); setSource("poll"); setLastUpdate(new Date())
      } catch { setConnected(false); setSource("offline") }
      timer = setTimeout(pollFallback,30000)
    }
    connectSSE()
    return () => { es?.close(); clearTimeout(timer) }
  },[applyMaintenance])

  return {stations,connected,source,lastUpdate}
}

// ─── COMPONENTES BASE ─────────────────────────────────────────────────────────
function Badge({status}){
  const cfg = STATUS[status]??STATUS.unknown
  return (
    <span style={{display:"inline-flex",alignItems:"center",gap:5,
      padding:"3px 10px",borderRadius:20,fontSize:11,fontWeight:600,
      background:cfg.bg,color:cfg.text,border:`1px solid ${cfg.border}`}}>
      <span style={{width:6,height:6,borderRadius:"50%",background:cfg.dot,display:"inline-block"}}/>
      {cfg.label}
    </span>
  )
}

function Card({children,style,accent}){
  return (
    <div style={{background:C.white,borderRadius:12,padding:"20px 22px",
      border:`1px solid ${accent?accent+"30":C.grayBorder}`,
      boxShadow:"0 1px 4px rgba(0,0,0,0.04)",...style}}>
      {children}
    </div>
  )
}

function SectionTitle({children,sub,action}){
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
      <div>
        <div style={{fontSize:14,fontWeight:700,color:C.text}}>{children}</div>
        {sub&&<div style={{fontSize:12,color:C.textLight,marginTop:2}}>{sub}</div>}
      </div>
      {action}
    </div>
  )
}

function StatCard({label,value,sub,color,bg,trend}){
  return (
    <div style={{background:bg??C.white,borderRadius:12,padding:"18px 20px",
      border:`1px solid ${C.grayBorder}`,boxShadow:"0 1px 4px rgba(0,0,0,0.04)"}}>
      <div style={{fontSize:12,color:C.textLight,fontWeight:500,marginBottom:6}}>{label}</div>
      <div style={{fontSize:26,fontWeight:800,color:color??C.text,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:C.textLight,marginTop:5}}>{sub}</div>}
    </div>
  )
}

// ─── GRÁFICOS SVG ─────────────────────────────────────────────────────────────
function DonutChart({segments,size=130}){
  const r=42,cx=size/2,cy=size/2,circ=2*Math.PI*r
  const total=segments.reduce((a,s)=>a+s.value,0)
  if(!total) return null
  let offset=0
  return (
    <svg width={size} height={size} style={{transform:"rotate(-90deg)"}}>
      {segments.map((s,i)=>{
        const pct=s.value/total, dash=pct*circ, gap=circ-dash
        const el=<circle key={i} cx={cx} cy={cy} r={r} fill="none"
          stroke={s.color} strokeWidth="20"
          strokeDasharray={`${dash} ${gap}`}
          strokeDashoffset={-offset*circ}/>
        offset+=pct; return el
      })}
      <circle cx={cx} cy={cy} r={r-10} fill="white"/>
    </svg>
  )
}

function MiniBar({value,max,color}){
  const pct = max>0?Math.min(100,(value/max)*100):0
  return (
    <div style={{height:5,background:C.grayLight,borderRadius:3,overflow:"hidden",marginTop:4}}>
      <div style={{width:`${pct}%`,height:"100%",background:color,borderRadius:3,transition:"width 0.4s"}}/>
    </div>
  )
}

// ─── ABA: DASHBOARD ───────────────────────────────────────────────────────────
function TabDashboard({stations}){
  const [periodo, setPeriodo] = useState("hoje")
  const [marca,   setMarca]   = useState("Todas")
  const [histData,setHistData]= useState(null)
  const [loading, setLoading] = useState(false)
  const now = Date.now()

  useEffect(()=>{
    setLoading(true)
    fetch(`${API_BASE}/api/historico?periodo=${periodo}`)
      .then(r=>r.json())
      .then(d=>{ setHistData(d); setLoading(false) })
      .catch(()=>{ setHistData(null); setLoading(false) })
  },[periodo])

  // ── KPIs globais (tempo real) ──────────────────────────────────────────────
  const cnt={operational:0,offline:0,error:0,maintenance:0,unavailable:0}
  stations.forEach(s=>{ if(cnt[s.status]!==undefined) cnt[s.status]++ })
  const critical = cnt.offline + cnt.error
  const totalKwh    = stations.reduce((a,s)=>a+(s.energiaTotal??0),0)
  const totalCargas = stations.reduce((a,s)=>a+(s.totalCargas??0),0)
  const totalZeradas= stations.reduce((a,s)=>a+(s.zeradas??0),0)
  const totalReceita= stations.reduce((a,s)=>a+(s.receitaDia??0),0)
  const taxaGlobal  = totalCargas>0?((totalCargas-totalZeradas)/totalCargas*100).toFixed(1):"—"
  const portaAberta = stations.filter(s=>s.portaAberta)
  const alertas     = stations.filter(s=>["offline","error"].includes(s.status)).slice(0,8)

  const donutSegs=[
    {label:"Operante",     value:cnt.operational, color:C.green },
    {label:"Indisponível", value:cnt.unavailable, color:C.yellow},
    {label:"Offline",      value:cnt.offline,     color:C.red   },
    {label:"Manutenção",   value:cnt.maintenance, color:C.blue  },
    {label:"Em erro",      value:cnt.error,       color:C.orange},
  ].filter(s=>s.value>0)

  // ── Dados de cargas (período selecionado) ──────────────────────────────────
  const stationMap = Object.fromEntries(stations.map(s=>[s.stationID,s]))
  const marcaCfg   = MARCAS.find(m=>m.label===marca)??MARCAS[0]

  const enriched = histData
    ? Object.entries(histData).map(([sid,cs])=>{
        const st=stationMap[sid]; if(!st) return null
        return {...cs,stationID:sid,name:st.name,vendor:st.vendor??null,status:st.status??"unknown"}
      }).filter(Boolean)
    : stations.filter(s=>s.totalCargas>0)

  const comDados = enriched
    .filter(s=>s.totalCargas>0)
    .filter(s=>matchMarca(s.vendor,marcaCfg.match))

  const MIN = periodo==="hoje"?2:periodo==="7d"?10:30
  const topConsumo    = [...comDados].sort((a,b)=>b.energiaTotal-a.energiaTotal).slice(0,5)
  const topErros      = [...comDados].filter(s=>s.zeradas>0).sort((a,b)=>b.zeradas-a.zeradas).slice(0,5)
  const topPctErro    = [...comDados].filter(s=>s.totalCargas>=MIN&&s.taxaSucesso>0&&s.taxaSucesso<100)
    .sort((a,b)=>a.taxaSucesso-b.taxaSucesso).slice(0,5)
  const topDesempenho = [...comDados].filter(s=>s.totalCargas>=MIN&&s.status!=="maintenance")
    .sort((a,b)=>b.taxaSucesso-a.taxaSucesso||b.totalCargas-a.totalCargas).slice(0,5)
  const pioresDesempenho = [...stations].filter(s=>s.totalCargas>=3&&s.status!=="maintenance")
    .sort((a,b)=>a.taxaSucesso-b.taxaSucesso||b.zeradas-a.zeradas).slice(0,5)

  const usuariosMap={}
  comDados.forEach(s=>{
    (s.usuariosZeradas??[]).forEach(u=>{ usuariosMap[u.email]=(usuariosMap[u.email]??0)+u.count })
  })
  const usuariosZeradas=Object.entries(usuariosMap)
    .map(([email,count])=>({email,count})).sort((a,b)=>b.count-a.count).slice(0,8)

  const periodoLabel = periodo==="hoje"?"hoje":periodo==="7d"?"7 dias":"30 dias"

  function RankCard({title,items,format,color}){
    const maxVal=items.length>0?parseFloat(format(items[0]).replace(/[^\d.]/g,""))||1:1
    return (
      <Card>
        <SectionTitle sub={periodoLabel}>{title}</SectionTitle>
        {loading&&<div style={{fontSize:12,color:C.textLight}}>Carregando...</div>}
        {!loading&&!items.length&&<div style={{fontSize:12,color:C.textLight}}>Sem dados suficientes.</div>}
        {!loading&&items.map((s,i)=>{
          const label=format(s)
          const numVal=parseFloat(label.replace(/[^\d.]/g,""))||0
          return (
            <div key={s.stationID} style={{marginBottom:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                <span style={{fontSize:11,color:C.textLight,minWidth:18,fontWeight:600}}>#{i+1}</span>
                <div style={{flex:1,minWidth:0}}>
                  <span style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:C.blue,marginRight:6}}>{s.stationID}</span>
                  <span style={{fontSize:11,color:C.textLight,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                    title={s.name}>{s.name?.replace(/ZON \([A-Z]+\) /,"")?.split(" - ")[0]?.trim()}</span>
                </div>
                <span style={{fontSize:13,fontWeight:800,color,whiteSpace:"nowrap"}}>{label}</span>
              </div>
              <MiniBar value={numVal} max={maxVal} color={color}/>
            </div>
          )
        })}
      </Card>
    )
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>

      {/* ── SEÇÃO 1: KPIs GLOBAIS TEMPO REAL ──────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:12}}>
        <StatCard label="Total estações"  value={stations.length}
          sub="monitoradas" color={C.blue}/>
        <StatCard label="Operantes"       value={cnt.operational}
          sub={`${((cnt.operational/Math.max(stations.length,1))*100).toFixed(0)}% da frota`}
          color={C.green} bg={C.greenLight}/>
        <StatCard label="Críticos"        value={critical}
          sub={`${cnt.offline} offline · ${cnt.error} erro`}
          color={critical>0?C.red:C.green} bg={critical>0?C.redLight:C.greenLight}/>
        <StatCard label="Indisponíveis"   value={cnt.unavailable}
          sub="sem tx recente" color={C.yellow} bg={C.yellowLight}/>
        <StatCard label="Manutenção"      value={cnt.maintenance}
          sub="fora de serviço" color={C.blue} bg={C.blueLight}/>
        <StatCard label="Taxa global"
          value={taxaGlobal!=="—"?`${taxaGlobal}%`:loading?"...":"—"}
          sub={`${totalCargas} cargas hoje`}
          color={parseFloat(taxaGlobal)>=90?C.green:parseFloat(taxaGlobal)>=75?C.yellow:C.red}
          bg={parseFloat(taxaGlobal)>=90?C.greenLight:parseFloat(taxaGlobal)>=75?C.yellowLight:C.redLight}/>
        <StatCard label="Energia hoje"
          value={loading&&totalKwh===0?"...":totalKwh>=1000?`${(totalKwh/1000).toFixed(2)} MWh`:`${totalKwh.toFixed(1)} kWh`}
          sub={`R$ ${(totalReceita/100).toFixed(0)} · ${totalZeradas} zeradas`}
          color={C.blue}/>
      </div>

      {/* ── SEÇÃO 2: STATUS + ALERTAS ─────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"260px 1fr",gap:16}}>
        <Card>
          <SectionTitle>Distribuição</SectionTitle>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
            <div style={{position:"relative",marginBottom:14}}>
              <DonutChart segments={donutSegs} size={120}/>
              <div style={{position:"absolute",top:"50%",left:"50%",
                transform:"translate(-50%,-50%)",textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:800,color:C.text}}>{stations.length}</div>
                <div style={{fontSize:9,color:C.textLight}}>total</div>
              </div>
            </div>
            {donutSegs.map(s=>(
              <div key={s.label} style={{display:"flex",alignItems:"center",gap:8,width:"100%",marginBottom:5}}>
                <div style={{width:9,height:9,borderRadius:"50%",background:s.color,flexShrink:0}}/>
                <span style={{fontSize:12,color:C.textMid,flex:1}}>{s.label}</span>
                <span style={{fontSize:13,fontWeight:700,color:s.color}}>{s.value}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle sub={`${alertas.length} estação${alertas.length!==1?"s":""} requerendo atenção`}>
            Alertas ativos
          </SectionTitle>
          {portaAberta.length>0&&(
            <div style={{marginBottom:10,padding:"10px 14px",borderRadius:8,
              background:C.redLight,border:"1px solid #fecaca",
              display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:16}}>🚪</span>
              <span style={{fontSize:12,fontWeight:700,color:C.red}}>
                PORTA ABERTA: {portaAberta.map(s=>s.stationID).join(", ")}
              </span>
            </div>
          )}
          {!alertas.length&&(
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"14px",
              borderRadius:8,background:C.greenLight,border:"1px solid #bbf7d0"}}>
              <span style={{fontSize:18}}>✓</span>
              <span style={{fontSize:13,color:C.green,fontWeight:600}}>Nenhum alerta crítico ativo</span>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {alertas.map(s=>{
              const cfg=STATUS[s.status]
              return (
                <div key={s.stationID} style={{display:"flex",alignItems:"center",gap:12,
                  padding:"9px 13px",borderRadius:8,background:cfg.bg,border:`1px solid ${cfg.border}`}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:cfg.dot,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <span style={{fontSize:12,fontWeight:700,color:C.text,marginRight:8}}>{s.stationID}</span>
                    <span style={{fontSize:12,color:C.textLight,overflow:"hidden",
                      textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</span>
                  </div>
                  <Badge status={s.status}/>
                  <span style={{fontSize:11,color:C.textLight,whiteSpace:"nowrap"}}>{dur(now-s.statusSince)}</span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      {/* ── SEÇÃO 3: PIORES DESEMPENHOS (tempo real) ─────────────── */}
      <Card>
        <SectionTitle sub="menor taxa de sucesso hoje · mín. 3 cargas">Piores desempenhos</SectionTitle>
        <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
          {pioresDesempenho.map((s,i)=>(
            <div key={s.stationID} style={{background:C.grayLight,borderRadius:10,
              padding:"14px 16px",border:`1px solid ${C.grayBorder}`}}>
              <div style={{fontSize:10,color:C.textLight,marginBottom:6,fontWeight:600}}>#{i+1}</div>
              <div style={{fontSize:11,fontFamily:"monospace",fontWeight:700,color:C.blue,marginBottom:4}}>
                {s.stationID}
              </div>
              <div style={{fontSize:11,color:C.textLight,marginBottom:10,
                overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                title={s.name}>{s.name?.replace(/ZON \([A-Z]+\) /,"")?.split(" - ")[0]}</div>
              <div style={{fontSize:24,fontWeight:800,
                color:s.taxaSucesso>=80?C.yellow:C.red}}>{s.taxaSucesso}%</div>
              <MiniBar value={s.taxaSucesso} max={100} color={s.taxaSucesso>=80?C.yellow:C.red}/>
              <div style={{fontSize:10,color:C.textLight,marginTop:6}}>
                {s.zeradas} zeradas · {s.totalCargas} total
              </div>
            </div>
          ))}
          {!pioresDesempenho.length&&(
            <div style={{fontSize:12,color:C.textLight,gridColumn:"span 5"}}>Sem dados suficientes.</div>
          )}
        </div>
      </Card>

      {/* ── SEÇÃO 4: FILTROS DE PERÍODO ──────────────────────────── */}
      <Card style={{padding:"14px 20px"}}>
        <div style={{display:"flex",gap:24,alignItems:"center",flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:C.textLight,
              textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:7}}>Análise por período</div>
            <div style={{display:"flex",gap:6}}>
              {[["hoje","Hoje"],["7d","7 dias"],["30d","30 dias"]].map(([k,v])=>(
                <button key={k} onClick={()=>setPeriodo(k)} style={{
                  padding:"7px 18px",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",
                  border:`2px solid ${periodo===k?C.orange:C.grayBorder}`,
                  background:periodo===k?C.orange:C.white,
                  color:periodo===k?C.white:C.textMid,
                  boxShadow:periodo===k?"0 2px 8px rgba(244,121,32,0.3)":"none",
                  transition:"all 0.15s"}}>{v}
                </button>
              ))}
            </div>
          </div>
          <div style={{width:1,height:40,background:C.grayBorder}}/>
          <div>
            <div style={{fontSize:10,fontWeight:700,color:C.textLight,
              textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:7}}>Fabricante</div>
            <div style={{display:"flex",gap:6}}>
              {MARCAS.map(m=>{
                const active=marca===m.label
                const count=m.match?stations.filter(s=>matchMarca(s.vendor,m.match)).length:null
                return (
                  <button key={m.label} onClick={()=>setMarca(m.label)} style={{
                    padding:"7px 16px",borderRadius:8,fontSize:13,fontWeight:600,cursor:"pointer",
                    border:`2px solid ${active?C.orange:C.grayBorder}`,
                    background:active?C.orange:C.white,color:active?C.white:C.textMid,
                    boxShadow:active?"0 2px 8px rgba(244,121,32,0.3)":"none",
                    transition:"all 0.15s"}}>
                    {m.label}{count!==null?` (${count})`:""}
                  </button>
                )
              })}
            </div>
          </div>
          <div style={{marginLeft:"auto",textAlign:"right"}}>
            {loading
              ? <div style={{display:"flex",alignItems:"center",gap:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:C.orange}}/>
                  <span style={{fontSize:12,color:C.orange,fontWeight:600}}>Carregando...</span>
                </div>
              : <div>
                  <div style={{fontSize:14,fontWeight:700,color:C.text}}>{comDados.length} estações</div>
                  <div style={{fontSize:11,color:C.textLight}}>{periodoLabel}</div>
                </div>
            }
          </div>
        </div>
      </Card>

      {/* ── SEÇÃO 5: RANKINGS ─────────────────────────────────────── */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <RankCard title="Maior consumo"      items={topConsumo}
          format={s=>`${s.energiaTotal.toFixed(1)} kWh`} color={C.blue}/>
        <RankCard title="Melhor desempenho"  items={topDesempenho}
          format={s=>`${s.taxaSucesso}%`}                color={C.green}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
        <RankCard title="Mais cargas zeradas" items={topErros}
          format={s=>`${s.zeradas}`}                     color={C.red}/>
        <RankCard title="Maior taxa de erro"  items={topPctErro}
          format={s=>`${(100-s.taxaSucesso).toFixed(1)}%`} color={C.orange}/>
      </div>

      {/* ── SEÇÃO 6: USUÁRIOS ─────────────────────────────────────── */}
      {usuariosZeradas.length>0&&(
        <Card>
          <SectionTitle sub={periodoLabel}>Usuários com mais cargas zeradas</SectionTitle>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8}}>
            {usuariosZeradas.map((u,i)=>(
              <div key={u.email} style={{display:"flex",alignItems:"center",gap:10,
                padding:"8px 12px",borderRadius:8,background:C.grayLight,
                border:`1px solid ${C.grayBorder}`}}>
                <div style={{width:26,height:26,borderRadius:"50%",
                  background:i<3?C.orange:C.blueLight,
                  display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:11,fontWeight:700,color:i<3?C.white:C.blue,flexShrink:0}}>
                  {i+1}
                </div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,color:C.text,overflow:"hidden",
                    textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{u.email}</div>
                </div>
                <span style={{fontSize:13,fontWeight:800,color:C.red}}>{u.count}×</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ─── ABA: ESTAÇÕES ────────────────────────────────────────────────────────────
function TabStations({stations,onSelect}){
  const [filter,    setFilter]    = useState("all")
  const [search,    setSearch]    = useState("")
  const [sort,      setSort]      = useState("status")
  const [sortDir,   setSortDir]   = useState(1)
  const [ignoradas, setIgnoradas] = useState([])
  const [showIgn,   setShowIgn]   = useState(false)
  const [confirmRm, setConfirmRm] = useState(null)
  const [motivo,    setMotivo]    = useState("")
  const [feedback,  setFeedback]  = useState(null)
  const now = Date.now()

  useEffect(()=>{
    fetch(`${API_BASE}/api/ignoradas`).then(r=>r.json()).then(setIgnoradas).catch(()=>{})
  },[])

  function showFb(type,msg){ setFeedback({type,msg}); setTimeout(()=>setFeedback(null),3500) }

  async function handleIgnorar(sid){
    try{
      await fetch(`${API_BASE}/api/ignoradas/${sid}`,{
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({motivo})
      })
      setIgnoradas(ig=>[...ig,{stationID:sid,motivo,removidoEm:new Date().toISOString()}])
      showFb("ok",`${sid} removida do monitoramento.`)
      setConfirmRm(null); setMotivo("")
    } catch(e){ showFb("err",e.message) }
  }

  async function handleRestaurar(sid){
    try{
      await fetch(`${API_BASE}/api/ignoradas/${sid}`,{method:"DELETE"})
      setIgnoradas(ig=>ig.filter(s=>s.stationID!==sid))
      showFb("ok",`${sid} restaurada ao monitoramento.`)
    } catch(e){ showFb("err",e.message) }
  }

  const ORDER = {offline:0,error:1,unavailable:2,maintenance:3,operational:4,unknown:5}
  const counts = {all:stations.length}
  stations.forEach(s=>{ counts[s.status]=(counts[s.status]??0)+1 })

  function sortVal(s){
    if(sort==="status")    return ORDER[s.status]??5
    if(sort==="tempo")     return now - (s.statusSince??0)
    if(sort==="hb")        return s.lastHeartbeat ? now - s.lastHeartbeat : Infinity
    if(sort==="potencia")  return -(s.power??0)
    if(sort==="score")     return -(s.silentScore??0)
    if(sort==="fabricante")return (s.vendor??"").toLowerCase()
    return 0
  }

  const rows = stations
    .filter(s => filter==="all" || s.status===filter)
    .filter(s => !search ||
      s.stationID.toLowerCase().includes(search.toLowerCase()) ||
      (s.name??"").toLowerCase().includes(search.toLowerCase()) ||
      (s.vendor??"").toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>{
      const va=sortVal(a), vb=sortVal(b)
      return sortDir * (va<vb?-1:va>vb?1:0)
    })

  function thClick(key){
    if(sort===key) setSortDir(d=>-d); else { setSort(key); setSortDir(1) }
  }
  function thArr(key){ return sort===key?(sortDir===1?"↑":"↓"):"" }

  const thSt = {
    fontSize:10, fontWeight:700, color:C.textLight, padding:"10px 10px",
    textAlign:"left", borderBottom:`1px solid ${C.grayBorder}`,
    textTransform:"uppercase", letterSpacing:"0.06em",
    whiteSpace:"nowrap", cursor:"pointer", userSelect:"none",
    background:C.grayLight,
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>

      {/* Toast */}
      {feedback&&(
        <div style={{position:"fixed",top:20,right:24,zIndex:9999,padding:"12px 22px",
          borderRadius:10,fontWeight:700,fontSize:13,color:"#fff",
          background:feedback.type==="ok"?C.green:C.red,
          boxShadow:"0 8px 24px rgba(0,0,0,0.15)"}}>
          {feedback.type==="ok"?"✓  ":"✗  "}{feedback.msg}
        </div>
      )}

      {/* Modal de remoção */}
      {confirmRm&&(
        <div style={{position:"fixed",inset:0,background:"rgba(15,30,53,0.6)",zIndex:200,
          display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:C.white,borderRadius:16,width:"min(460px,95vw)",
            boxShadow:"0 24px 64px rgba(0,0,0,0.2)",overflow:"hidden"}}>
            <div style={{background:C.sidebar,padding:"18px 22px",display:"flex",
              justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:14,fontWeight:700,color:"#fff"}}>Remover do monitoramento</div>
              <button onClick={()=>{setConfirmRm(null);setMotivo("")}}
                style={{fontSize:12,padding:"5px 12px",borderRadius:6,
                  border:"1px solid rgba(255,255,255,0.2)",background:"transparent",
                  color:"rgba(255,255,255,0.7)",cursor:"pointer"}}>fechar</button>
            </div>
            <div style={{padding:"20px 22px",display:"flex",flexDirection:"column",gap:14}}>
              <div style={{background:C.redLight,borderRadius:8,padding:"12px 14px",
                border:"1px solid #fecaca",fontSize:13,color:C.red}}>
                <strong>{confirmRm}</strong> será ocultada do Sentinela. A estação continua existindo na Tupi.
              </div>
              <div>
                <label style={{fontSize:11,fontWeight:700,color:C.textMid,
                  textTransform:"uppercase",letterSpacing:.5,display:"block",marginBottom:5}}>
                  Motivo (opcional)
                </label>
                <input type="text" value={motivo} onChange={e=>setMotivo(e.target.value)}
                  placeholder="Ex: Estação desativada, fora do contrato..."
                  style={{fontSize:12,padding:"9px 12px",borderRadius:8,
                    border:`1.5px solid ${C.grayBorder}`,width:"100%",
                    boxSizing:"border-box",color:C.text,fontFamily:"inherit"}}/>
              </div>
              <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
                <button onClick={()=>{setConfirmRm(null);setMotivo("")}}
                  style={{padding:"8px 18px",borderRadius:8,border:`1.5px solid ${C.grayBorder}`,
                    background:C.white,color:C.textMid,fontWeight:600,fontSize:12,cursor:"pointer"}}>
                  Cancelar
                </button>
                <button onClick={()=>handleIgnorar(confirmRm)}
                  style={{padding:"8px 20px",borderRadius:8,border:"none",
                    background:C.red,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer"}}>
                  Remover do monitoramento
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Painel de ignoradas */}
      {showIgn&&ignoradas.length>0&&(
        <Card style={{border:`2px solid ${C.orange}30`}}>
          <div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:12,
            display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>Estações removidas do monitoramento ({ignoradas.length})</span>
            <button onClick={()=>setShowIgn(false)}
              style={{fontSize:11,padding:"4px 10px",borderRadius:6,
                border:`1px solid ${C.grayBorder}`,background:C.white,color:C.textMid,cursor:"pointer"}}>
              fechar
            </button>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {ignoradas.map(ig=>(
              <div key={ig.stationID} style={{display:"flex",alignItems:"center",gap:12,
                padding:"10px 14px",borderRadius:8,background:C.grayLight,
                border:`1px solid ${C.grayBorder}`}}>
                <span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,
                  color:C.blue,minWidth:80}}>{ig.stationID}</span>
                <span style={{fontSize:12,color:C.textMid,flex:1}}>{ig.motivo||"—"}</span>
                <span style={{fontSize:11,color:C.textLight,whiteSpace:"nowrap"}}>
                  {new Date(ig.removidoEm).toLocaleDateString("pt-BR")}
                </span>
                <button onClick={()=>handleRestaurar(ig.stationID)}
                  style={{padding:"5px 12px",borderRadius:6,fontSize:11,fontWeight:600,
                    border:`1.5px solid ${C.green}`,background:C.greenLight,
                    color:C.green,cursor:"pointer"}}>
                  ↩ Restaurar
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Tabela */}
      <Card style={{padding:0}}>

        {/* Barra de controles */}
        <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.grayBorder}`,
          display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Buscar por ID, nome ou fabricante..."
            style={{fontSize:13,padding:"8px 14px",borderRadius:8,
              border:`1.5px solid ${C.grayBorder}`,outline:"none",
              width:240,color:C.text,background:C.grayLight}}/>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {[
              ["all","Todos"],["operational","Operante"],["offline","Offline"],
              ["error","Erro"],["unavailable","Indisponível"],["maintenance","Manutenção"]
            ].map(([k,v])=>(
              <button key={k} onClick={()=>setFilter(k)} style={{
                fontSize:12,padding:"6px 12px",borderRadius:8,cursor:"pointer",
                border:`1.5px solid ${filter===k?C.orange:C.grayBorder}`,
                background:filter===k?C.orange:C.white,
                color:filter===k?C.white:C.textMid,
                fontWeight:filter===k?600:400,transition:"all 0.15s"}}>
                {v} ({counts[k]??0})
              </button>
            ))}
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
            {ignoradas.length>0&&(
              <button onClick={()=>setShowIgn(v=>!v)}
                style={{fontSize:11,padding:"6px 12px",borderRadius:8,cursor:"pointer",
                  border:`1.5px solid ${C.red}`,
                  background:showIgn?C.redLight:C.white,
                  color:C.red,fontWeight:600}}>
                ⊗ Removidas ({ignoradas.length})
              </button>
            )}
          </div>
        </div>

        {/* Contagem */}
        <div style={{padding:"7px 20px",fontSize:12,color:C.textLight,
          borderBottom:`1px solid ${C.grayBorder}`}}>
          {rows.length} de {stations.length} estações
        </div>

        {/* Tabela */}
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",tableLayout:"fixed"}}>
            <thead>
              <tr>
                <th onClick={()=>thClick("status")}   style={{...thSt,width:"7%"}}>ID {thArr("status")}</th>
                <th style={{...thSt,width:"18%",cursor:"default"}}>Nome</th>
                <th onClick={()=>thClick("status")}   style={{...thSt,width:"10%"}}>Status {thArr("status")}</th>
                <th onClick={()=>thClick("tempo")}    style={{...thSt,width:"9%"}}>Tempo {thArr("tempo")}</th>
                <th onClick={()=>thClick("hb")}       style={{...thSt,width:"9%"}}>Heartbeat {thArr("hb")}</th>
                <th onClick={()=>thClick("fabricante")}style={{...thSt,width:"9%"}}>Fabricante {thArr("fabricante")}</th>
                <th onClick={()=>thClick("potencia")} style={{...thSt,width:"7%"}}>Potência {thArr("potencia")}</th>
                <th style={{...thSt,width:"8%",cursor:"default"}}>Firmware</th>
                <th style={{...thSt,width:"10%",cursor:"default"}}>Conectores</th>
                <th style={{...thSt,width:"8%",cursor:"default"}}>API pública</th>
                <th onClick={()=>thClick("score")}    style={{...thSt,width:"6%"}}>Score {thArr("score")}</th>
                <th style={{...thSt,width:"5%",cursor:"default"}}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s,i)=>{
                const cfg    = STATUS[s.status]??STATUS.unknown
                const apiCol = s.stationApiAvailable?C.green:s.stationApiCharging?C.orange:s.stationApiFaulted?C.red:C.textLight
                const connectors = s.connectors??[]
                const faulted    = connectors.filter(c=>["Faulted","Unavailable"].includes(c.lastStatus))
                const charging   = connectors.filter(c=>c.lastStatus==="Charging")
                const available  = connectors.filter(c=>c.lastStatus==="Available")

                return (
                  <tr key={s.stationID} onClick={()=>onSelect(s)}
                    style={{background:i%2===0?C.white:"#fafbfc",cursor:"pointer",transition:"background 0.1s"}}
                    onMouseEnter={e=>e.currentTarget.style.background=C.blueLight}
                    onMouseLeave={e=>e.currentTarget.style.background=i%2===0?C.white:"#fafbfc"}>

                    {/* ID */}
                    <td style={{padding:"9px 10px",fontSize:11,fontFamily:"monospace",
                      fontWeight:700,color:C.blue,borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.stationID}
                    </td>

                    {/* Nome */}
                    <td style={{padding:"9px 10px",fontSize:12,color:C.text,
                      borderBottom:`1px solid ${C.grayBorder}`,overflow:"hidden",
                      textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={s.name}>
                      {s.name?.replace(/ZON \([A-Z]+\) /,"")}
                    </td>

                    {/* Status */}
                    <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.grayBorder}`}}>
                      <Badge status={s.status}/>
                    </td>

                    {/* Tempo no status */}
                    <td style={{padding:"9px 10px",fontSize:12,color:C.textMid,
                      borderBottom:`1px solid ${C.grayBorder}`}}>
                      {dur(now-(s.statusSince??now))}
                    </td>

                    {/* Último heartbeat */}
                    <td style={{padding:"9px 10px",fontSize:12,borderBottom:`1px solid ${C.grayBorder}`,
                      color:s.lastHeartbeat&&(now-s.lastHeartbeat)<5*60000?C.green
                           :s.lastHeartbeat&&(now-s.lastHeartbeat)<30*60000?C.yellow:C.red}}>
                      {s.lastHeartbeat?ago(s.lastHeartbeat):"—"}
                    </td>

                    {/* Fabricante */}
                    <td style={{padding:"9px 10px",fontSize:11,color:C.textMid,
                      borderBottom:`1px solid ${C.grayBorder}`,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                      title={s.vendor??""}>
                      {s.vendor||"—"}
                    </td>

                    {/* Potência */}
                    <td style={{padding:"9px 10px",fontSize:12,fontWeight:600,
                      color:s.power?C.blue:C.textLight,
                      borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.power?`${s.power} kW`:"—"}
                    </td>

                    {/* Firmware */}
                    <td style={{padding:"9px 10px",fontSize:10,color:C.textLight,
                      borderBottom:`1px solid ${C.grayBorder}`,
                      overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}
                      title={s.firmware??""}>
                      {s.firmware||"—"}
                    </td>

                    {/* Conectores */}
                    <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.grayBorder}`}}>
                      {connectors.length===0 ? (
                        <span style={{fontSize:11,color:C.textLight}}>—</span>
                      ) : (
                        <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                          {connectors.map(c=>{
                            const cc = c.lastStatus==="Available"?C.green
                              :c.lastStatus==="Charging"?C.orange
                              :["Faulted","Unavailable"].includes(c.lastStatus)?C.red
                              :C.textLight
                            return (
                              <span key={c.connectorId}
                                title={`C${c.connectorId}: ${c.lastStatus}`}
                                style={{fontSize:10,padding:"2px 6px",borderRadius:4,
                                  background:`${cc}18`,color:cc,border:`1px solid ${cc}40`,
                                  fontWeight:600,whiteSpace:"nowrap"}}>
                                C{c.connectorId}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </td>

                    {/* API pública */}
                    <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.stationApiStatus&&(
                        <span style={{fontSize:10,padding:"2px 8px",borderRadius:20,
                          fontWeight:600,background:`${apiCol}18`,color:apiCol,
                          border:`1px solid ${apiCol}40`}}>{s.stationApiStatus}</span>
                      )}
                    </td>

                    {/* Score */}
                    <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.grayBorder}`}}>
                      {(s.silentScore??0)>0&&(
                        <span title={s.silentReasons?.map(r=>SILENT_LABEL[r]||r).join(", ")}
                          style={{fontSize:11,padding:"2px 8px",borderRadius:20,fontWeight:700,
                            cursor:"help",
                            background:s.silentScore>=5?C.redLight:C.orangeLight,
                            color:s.silentScore>=5?C.red:C.orange}}>
                          ⚠ {s.silentScore}
                        </span>
                      )}
                    </td>

                    {/* Ação */}
                    <td style={{padding:"9px 10px",borderBottom:`1px solid ${C.grayBorder}`}}
                      onClick={e=>e.stopPropagation()}>
                      <button
                        onClick={e=>{ e.stopPropagation(); setConfirmRm(s.stationID); setMotivo("") }}
                        title="Remover do monitoramento"
                        style={{fontSize:11,padding:"3px 8px",borderRadius:6,cursor:"pointer",
                          border:`1px solid ${C.grayBorder}`,background:C.white,
                          color:C.red,fontWeight:600,opacity:.6,transition:"all .15s"}}
                        onMouseEnter={e=>{e.target.style.opacity=1;e.target.style.background=C.redLight}}
                        onMouseLeave={e=>{e.target.style.opacity=.6;e.target.style.background=C.white}}>
                        ⊗
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}

// ─── ABA: ALERTAS ─────────────────────────────────────────────────────────────
function TabAlerts({stations}){
  const now=Date.now()
  const alerts=stations.filter(s=>["offline","error","unavailable"].includes(s.status))
    .sort((a,b)=>({offline:0,error:1,unavailable:2}[a.status]??3)-({offline:0,error:1,unavailable:2}[b.status]??3))
  const portaAberta=stations.filter(s=>s.portaAberta)

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {portaAberta.length>0&&(
        <Card accent={C.red} style={{border:`2px solid ${C.red}30`}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <span style={{fontSize:20}}>🚪</span>
            <span style={{fontSize:14,fontWeight:700,color:C.red}}>
              PORTA DE GABINETE ABERTA — Verificação presencial necessária
            </span>
          </div>
          {portaAberta.map(s=>(
            <div key={s.stationID} style={{display:"flex",alignItems:"center",gap:12,
              padding:"10px 14px",background:C.white,borderRadius:8,marginBottom:6,
              border:`1px solid #fecaca`}}>
              <span style={{fontFamily:"monospace",fontSize:12,fontWeight:700,color:C.blue}}>{s.stationID}</span>
              <span style={{fontSize:13,color:C.text,flex:1}}>{s.name}</span>
              <span style={{fontSize:12,color:C.red,fontWeight:600}}>BoxDoorIsOpen</span>
            </div>
          ))}
        </Card>
      )}
      <Card>
        <SectionTitle sub={`${alerts.length} estação${alerts.length!==1?"s":""} requerendo atenção`}>
          Alertas ativos
        </SectionTitle>
        {!alerts.length&&(
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"20px",
            borderRadius:10,background:C.greenLight,border:`1px solid #bbf7d0`}}>
            <span style={{fontSize:24}}>✓</span>
            <span style={{fontSize:13,color:C.green,fontWeight:600}}>
              Nenhum alerta ativo no momento.
            </span>
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {alerts.map(s=>{
            const cfg=STATUS[s.status]
            return (
              <div key={s.stationID} style={{display:"flex",alignItems:"flex-start",
                gap:14,padding:"14px 16px",borderRadius:10,
                background:cfg.bg,border:`1px solid ${cfg.border}`}}>
                <div style={{width:10,height:10,borderRadius:"50%",
                  background:cfg.dot,marginTop:3,flexShrink:0}}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,
                    marginBottom:4,flexWrap:"wrap"}}>
                    <span style={{fontFamily:"monospace",fontSize:12,
                      fontWeight:700,color:C.text}}>{s.stationID}</span>
                    <Badge status={s.status}/>
                    <span style={{fontSize:12,color:C.textLight}}>
                      há {dur(now-s.statusSince)}
                    </span>
                  </div>
                  <div style={{fontSize:13,color:C.text,marginBottom:s.silentReasons?.length?8:0}}>
                    {s.name}
                  </div>
                  {s.silentReasons?.length>0&&(
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {s.silentReasons.map(r=>(
                        <span key={r} style={{fontSize:11,padding:"2px 8px",borderRadius:20,
                          background:C.white,color:r==="porta_aberta"?C.red:C.orange,
                          border:`1px solid ${r==="porta_aberta"?"#fecaca":"#fed7aa"}`}}>
                          {SILENT_LABEL[r]||r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {s.logStatus&&s.logStatus!=="OK"&&(
                  <span style={{fontSize:11,padding:"3px 10px",borderRadius:20,
                    background:C.yellowLight,color:C.yellow,
                    border:`1px solid #fde68a`,flexShrink:0}}>
                    {s.logStatus}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

// ─── ABA: CARGAS ──────────────────────────────────────────────────────────────
function TabCharges({stations}){
  const [sort,setSort]=useState("zeradas")
  const comDados=stations.filter(s=>s.totalCargas>0)
  const totalCargas=comDados.reduce((a,s)=>a+s.totalCargas,0)
  const bemGeral=comDados.reduce((a,s)=>a+s.bemSucedidas,0)
  const zeradasGeral=comDados.reduce((a,s)=>a+s.zeradas,0)
  const kwhGeral=comDados.reduce((a,s)=>a+(s.energiaTotal??0),0)
  const taxaGeral=totalCargas>0?((bemGeral/totalCargas)*100).toFixed(1):"—"

  const rows=[...comDados].sort((a,b)=>{
    if(sort==="zeradas") return b.zeradas-a.zeradas
    if(sort==="taxa") return a.taxaSucesso-b.taxaSucesso
    if(sort==="total") return b.totalCargas-a.totalCargas
    if(sort==="kwh") return b.energiaTotal-a.energiaTotal
    return 0
  })

  return (
    <div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:16}}>
        <StatCard label="Total de cargas" value={totalCargas} color={C.blue}/>
        <StatCard label="Taxa de sucesso" value={`${taxaGeral}%`}
          color={taxaGeral>=90?C.green:C.orange}
          bg={taxaGeral>=90?C.greenLight:C.orangeLight}/>
        <StatCard label="Cargas zeradas" value={zeradasGeral}
          color={zeradasGeral>0?C.red:C.green}
          bg={zeradasGeral>0?C.redLight:C.greenLight}/>
        <StatCard label="Energia total" value={`${kwhGeral.toFixed(1)} kWh`} color={C.blue}/>
      </div>
      <Card style={{padding:0}}>
        <div style={{padding:"14px 20px",borderBottom:`1px solid ${C.grayBorder}`,
          display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:14,fontWeight:700,color:C.text}}>Por estação — hoje</span>
          <div style={{display:"flex",gap:6}}>
            {[["zeradas","Zeradas"],["taxa","Taxa"],["total","Total"],["kwh","kWh"]].map(([k,v])=>(
              <button key={k} onClick={()=>setSort(k)} style={{
                fontSize:11,padding:"5px 12px",borderRadius:8,cursor:"pointer",
                border:`1.5px solid ${sort===k?C.orange:C.grayBorder}`,
                background:sort===k?C.orangeLight:C.white,
                color:sort===k?C.orange:C.textMid,fontWeight:sort===k?600:400}}>
                {v}
              </button>
            ))}
          </div>
        </div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead>
              <tr style={{background:C.grayLight}}>
                {["ID","Nome","Total","Sucesso","Zeradas","Taxa %","kWh total","Média kWh"].map(h=>(
                  <th key={h} style={{fontSize:10,fontWeight:700,color:C.textLight,
                    padding:"10px 12px",textAlign:"left",
                    borderBottom:`1px solid ${C.grayBorder}`,
                    textTransform:"uppercase",letterSpacing:"0.06em"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s,i)=>{
                const taxaCol=s.taxaSucesso>=95?C.green:s.taxaSucesso>=80?C.yellow:C.red
                return (
                  <tr key={s.stationID} style={{background:i%2===0?C.white:"#fafbfc"}}>
                    <td style={{padding:"10px 12px",fontSize:11,fontFamily:"monospace",
                      fontWeight:700,color:C.blue,borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.stationID}
                    </td>
                    <td style={{padding:"10px 12px",fontSize:12,color:C.text,
                      borderBottom:`1px solid ${C.grayBorder}`,overflow:"hidden",
                      textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:220}}
                      title={s.name}>{s.name?.replace(/ZON \([A-Z]+\) /,"")}</td>
                    <td style={{padding:"10px 12px",fontSize:13,color:C.text,
                      borderBottom:`1px solid ${C.grayBorder}`}}>{s.totalCargas}</td>
                    <td style={{padding:"10px 12px",fontSize:13,color:C.green,
                      fontWeight:600,borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.bemSucedidas}</td>
                    <td style={{padding:"10px 12px",fontSize:13,
                      color:s.zeradas>0?C.red:C.textLight,fontWeight:s.zeradas>0?700:400,
                      borderBottom:`1px solid ${C.grayBorder}`}}>{s.zeradas||"—"}</td>
                    <td style={{padding:"10px 12px",fontSize:13,fontWeight:700,
                      color:taxaCol,borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.taxaSucesso}%</td>
                    <td style={{padding:"10px 12px",fontSize:13,color:C.blue,
                      borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.energiaTotal?.toFixed(1)}</td>
                    <td style={{padding:"10px 12px",fontSize:13,color:C.textLight,
                      borderBottom:`1px solid ${C.grayBorder}`}}>
                      {s.mediaKwh?.toFixed(1)} kWh</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}


// ─── ABA: DISPONIBILIDADE ────────────────────────────────────────────────────
function TabAvailability({stations}){
  const [dias,     setDias]    = useState(1)
  const [data,     setData]    = useState(null)
  const [loading,  setLoading] = useState(false)
  const [search,   setSearch]  = useState("")
  const [sort,     setSort]    = useState("disponibilidade")
  const [sortDir,  setSortDir] = useState(1)
  const [expanded, setExpanded]= useState(null)
  const now = Date.now()

  useEffect(()=>{
    setLoading(true)
    fetch(`${API_BASE}/api/disponibilidade?dias=${dias}`)
      .then(r=>r.json())
      .then(d=>{ setData(d); setLoading(false) })
      .catch(()=>setLoading(false))
  },[dias])

  function dispColor(pct){ if(pct===null||pct===undefined) return C.textLight; if(pct>=95) return C.green; if(pct>=80) return C.yellow; return C.red }
  function dispBg(pct){    if(pct===null||pct===undefined) return C.grayLight;  if(pct>=95) return C.greenLight; if(pct>=80) return C.yellowLight; return C.redLight }
  function dispBorder(pct){if(pct===null||pct===undefined) return C.grayBorder; if(pct>=95) return "#bbf7d0"; if(pct>=80) return "#fde68a"; return "#fecaca" }
  function fmtMin(min){ if(!min||min<=0) return "—"; if(min<60) return `${min}min`; return `${Math.floor(min/60)}h ${min%60}min` }
  function fmtTs(ts){ if(!ts) return "—"; return new Date(ts - 3*3600000).toISOString().slice(11,16) }

  const rows = data ? Object.values(data)
    .filter(d=>!search||d.stationID.toLowerCase().includes(search.toLowerCase())||(d.name??"").toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>{
      const va=sort==="disponibilidade"?(a.disponibilidade??-1):sort==="minOffline"?(a.totalMinOffline??0):sort==="quedas"?(a.totalQuedas??0):(a.totalDisc1006??0)
      const vb=sort==="disponibilidade"?(b.disponibilidade??-1):sort==="minOffline"?(b.totalMinOffline??0):sort==="quedas"?(b.totalQuedas??0):(b.totalDisc1006??0)
      return sortDir*(va<vb?-1:va>vb?1:0)
    })
  : []

  const validRows   = rows.filter(r=>r.disponibilidade!==null)
  const mediaGlobal = validRows.length ? (validRows.reduce((a,r)=>a+r.disponibilidade,0)/validRows.length).toFixed(1) : null
  const criticas    = validRows.filter(r=>r.disponibilidade<80).length
  const alertas     = validRows.filter(r=>r.disponibilidade>=80&&r.disponibilidade<95).length
  const excelentes  = validRows.filter(r=>r.disponibilidade>=95).length
  const totalDisc   = validRows.reduce((a,r)=>a+(r.totalDisc1006??0),0)
  const periodLabel = dias===1?"24 horas":dias===7?"7 dias":dias===14?"14 dias":"30 dias"

  function Timeline({snaps}){
    if(!snaps||!snaps.length) return <span style={{fontSize:11,color:C.textLight}}>Sem dados</span>
    const W=280, H=24
    const sampled = snaps.filter((_,i)=>i%Math.max(1,Math.floor(snaps.length/96))===0).slice(-96)
    const barW = W/sampled.length
    return (
      <svg width={W} height={H} style={{display:"block"}}>
        {sampled.map((s,i)=>{
          const col=s.status==="operational"||s.status==="unavailable"?"#16a34a":s.status==="offline"?"#dc2626":s.status==="error"?"#f47920":"#9ca3af"
          return <rect key={i} x={i*barW} y={0} width={barW-0.5} height={H} fill={col} opacity={0.85}/>
        })}
      </svg>
    )
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
        <div>
          <div style={{fontSize:14,fontWeight:700,color:C.text}}>Disponibilidade das Estações</div>
          <div style={{fontSize:12,color:C.textLight,marginTop:2}}>Tempo conectado ao sistema Tupi · heartbeat OCPP</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          {[[1,"24h"],[7,"7 dias"],[14,"14 dias"],[30,"30 dias"]].map(([d,label])=>(
            <button key={d} onClick={()=>setDias(d)} style={{padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",
              border:`2px solid ${dias===d?C.orange:C.grayBorder}`,background:dias===d?C.orange:C.white,color:dias===d?C.white:C.textMid}}>
              {label}
            </button>
          ))}
          <button onClick={()=>window.open(`${API_BASE}/api/disponibilidade/relatorio?dias=${dias}`,"_blank")}
            style={{padding:"7px 14px",borderRadius:8,fontSize:12,fontWeight:600,cursor:"pointer",
              border:`2px solid ${C.blue}`,background:C.blueLight,color:C.blue}}>
            ↓ Relatório
          </button>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar..."
            style={{padding:"7px 12px",borderRadius:8,border:`1.5px solid ${C.grayBorder}`,fontSize:12,width:160,color:C.text}}/>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
        <StatCard label="Disp. média"       value={mediaGlobal!==null?`${mediaGlobal}%`:loading?"...":"—"} color={parseFloat(mediaGlobal)>=95?C.green:parseFloat(mediaGlobal)>=80?C.yellow:C.red} bg={parseFloat(mediaGlobal)>=95?C.greenLight:parseFloat(mediaGlobal)>=80?C.yellowLight:C.redLight} sub={periodLabel}/>
        <StatCard label="Excelente (≥95%)"  value={excelentes} color={C.green}  bg={C.greenLight}  sub="sem problemas"/>
        <StatCard label="Atenção (80–95%)"  value={alertas}    color={C.yellow} bg={C.yellowLight} sub="monitorar"/>
        <StatCard label="Críticas (<80%)"   value={criticas}   color={criticas>0?C.red:C.green} bg={criticas>0?C.redLight:C.greenLight} sub="intervenção"/>
        <StatCard label="Disc. 1006 total"  value={totalDisc}  color={totalDisc>10?C.red:totalDisc>0?C.orange:C.green} bg={totalDisc>10?C.redLight:totalDisc>0?C.orangeLight:C.greenLight} sub="quedas OCPP"/>
      </div>

      {loading&&<Card><div style={{textAlign:"center",padding:32,color:C.textLight}}>Carregando...</div></Card>}

      {!loading&&rows.map(r=>{
        const pct=r.disponibilidade
        const col=dispColor(pct), bg=dispBg(pct), border=dispBorder(pct)
        const isExp=expanded===r.stationID
        const periods=r.dias?.[r.dias.length-1]?.offlinePeriods??[]
        const todaySnaps=r.todaySnaps??[]
        const disc=r.totalDisc1006??0, quedas=r.totalQuedas??0, minOff=r.totalMinOffline??0
        return (
          <div key={r.stationID} style={{background:C.white,borderRadius:12,border:`1px solid ${border}`,overflow:"hidden"}}>
            <div style={{height:4,background:C.grayBorder}}>
              <div style={{width:`${pct??0}%`,height:"100%",background:col,borderRadius:2}}/>
            </div>
            <div onClick={()=>setExpanded(isExp?null:r.stationID)}
              style={{padding:"14px 18px",cursor:"pointer",display:"flex",alignItems:"center",gap:16,userSelect:"none"}}>
              <div style={{minWidth:70,textAlign:"center",background:bg,borderRadius:8,padding:"8px 10px",border:`1px solid ${border}`}}>
                <div style={{fontSize:20,fontWeight:800,color:col,lineHeight:1}}>{pct!==null?`${pct}%`:"—"}</div>
                <div style={{fontSize:9,color:col,marginTop:2,fontWeight:600}}>DISP.</div>
              </div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                  <span style={{fontFamily:"monospace",fontSize:13,fontWeight:800,color:C.text}}>{r.stationID}</span>
                  <Badge status={r.status}/>
                  {disc>0&&<span style={{fontSize:10,padding:"1px 7px",borderRadius:20,background:disc>=5?C.redLight:C.orangeLight,color:disc>=5?C.red:C.orange,fontWeight:700}}>{disc}× 1006</span>}
                </div>
                <div style={{fontSize:12,color:C.textLight,marginBottom:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.name?.replace(/ZON \([A-Z]+\) /g,"")}</div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:C.textLight,marginBottom:2}}><span>24H ATRÁS</span><span>AGORA</span></div>
                <Timeline snaps={todaySnaps}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,75px)",gap:8,flexShrink:0}}>
                {[["Quedas",quedas,quedas>2?C.red:quedas>0?C.orange:C.green],["1006",disc,disc>=5?C.red:disc>0?C.orange:C.green],["Offline",fmtMin(minOff),minOff>60?C.red:minOff>0?C.orange:C.green]].map(([l,v,c])=>(
                  <div key={l} style={{textAlign:"center",background:C.grayLight,borderRadius:8,padding:"8px 4px",border:`1px solid ${C.grayBorder}`}}>
                    <div style={{fontSize:13,fontWeight:800,color:c}}>{v||"—"}</div>
                    <div style={{fontSize:9,color:C.textLight,marginTop:2}}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{fontSize:16,color:C.textLight,flexShrink:0,transform:isExp?"rotate(90deg)":"rotate(0deg)",transition:"transform .2s"}}>{'>'}</div>
            </div>
            {isExp&&(
              <div style={{borderTop:`1px solid ${C.grayBorder}`,padding:"16px 18px",display:"flex",flexDirection:"column",gap:12}}>
                {r.dias?.length>0&&(
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:.5,marginBottom:8}}>Histórico ({periodLabel})</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {r.dias.map(d=>(
                        <div key={d.date} style={{textAlign:"center",background:dispBg(d.disponibilidade),borderRadius:8,padding:"8px 12px",border:`1px solid ${dispBorder(d.disponibilidade)}`,minWidth:80}}>
                          <div style={{fontSize:13,fontWeight:800,color:dispColor(d.disponibilidade)}}>{d.disponibilidade!=null?`${d.disponibilidade}%`:"—"}</div>
                          <div style={{fontSize:9,color:C.textLight,marginTop:2}}>{new Date(d.date+"T12:00:00").toLocaleDateString("pt-BR",{day:"2-digit",month:"2-digit"})}</div>
                          {d.quedas>0&&<div style={{fontSize:9,color:C.red,marginTop:1}}>{d.quedas} queda{d.quedas>1?"s":""}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {periods.length>0&&(
                  <div>
                    <div style={{fontSize:10,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:.5,marginBottom:8}}>Períodos offline hoje</div>
                    {periods.map((p,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",borderRadius:8,marginBottom:6,background:C.redLight,border:"1px solid #fecaca"}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:C.red,flexShrink:0}}/>
                        <span style={{fontSize:12,color:C.text,fontWeight:600}}>{fmtTs(p.inicio)} {'->'} {p.fim?fmtTs(p.fim):"agora"}</span>
                        <span style={{fontSize:11,color:C.red,fontWeight:700,background:"rgba(220,38,38,0.1)",padding:"2px 8px",borderRadius:20}}>{fmtMin(p.duracaoMin)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {!periods.length&&<div style={{padding:"10px 14px",borderRadius:8,background:C.greenLight,border:"1px solid #bbf7d0",fontSize:12,color:C.green,fontWeight:600}}>✓ Nenhum período offline detectado hoje.</div>}
              </div>
            )}
          </div>
        )
      })}

      {!loading&&!rows.length&&<Card><div style={{textAlign:"center",padding:32,color:C.textLight,fontSize:13}}>{data?"Nenhuma estação encontrada.":"Aguardando dados..."}</div></Card>}
    </div>
  )
}

// ─── ABA: MANUTENÇÕES ─────────────────────────────────────────────────────────
function TabMaintenance({stations}){
  const now = Date.now()
  const manut = stations.filter(s=>s.status==="maintenance").sort((a,b)=>a.statusSince-b.statusSince)

  const FORM_EMPTY={stationID:"",since:new Date().toISOString().slice(0,10),causa:"",responsavel:"",prioridade:"media",previsao:"",observacoes:""}
  const [view,       setView]       = useState("lista")
  const [form,       setForm]       = useState(FORM_EMPTY)
  const [editingID,  setEditingID]  = useState(null)
  const [saving,     setSaving]     = useState(false)
  const [removing,   setRemoving]   = useState(null)
  const [confirmID,  setConfirmID]  = useState(null)
  const [expandedID, setExpandedID] = useState(null)
  const [feedback,   setFeedback]   = useState(null)

  function showFb(type,msg){ setFeedback({type,msg}); setTimeout(()=>setFeedback(null),4000) }

  const disponiveis = stations.filter(s=>s.status!=="maintenance").sort((a,b)=>a.stationID>b.stationID?1:-1)

  async function handleSave(){
    if(!form.stationID||!form.since){showFb("err","Estação e data de início são obrigatórios.");return}
    setSaving(true)
    try{
      const method=editingID?"PATCH":"POST"
      const url=editingID?`${API_BASE}/api/manutencoes/${editingID}`:`${API_BASE}/api/manutencoes`
      const res=await fetch(url,{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(form)})
      if(!res.ok) throw new Error((await res.json()).error||"Erro ao salvar")
      showFb("ok",editingID?`Manutenção de ${editingID} atualizada.`:`${form.stationID} colocada em manutenção.`)
      setView("lista");setForm(FORM_EMPTY);setEditingID(null)
    }catch(e){showFb("err",e.message)}finally{setSaving(false)}
  }

  async function handleRemove(sid){
    setRemoving(sid);setConfirmID(null)
    try{
      const res=await fetch(`${API_BASE}/api/manutencoes/${sid}`,{method:"DELETE"})
      if(!res.ok) throw new Error("Erro ao remover")
      showFb("ok",`${sid} retornou à operação.`);setExpandedID(null)
    }catch(e){showFb("err",e.message)}finally{setRemoving(null)}
  }

  function handleEdit(s){
    const info=s.maintenanceInfo||{}
    setForm({stationID:s.stationID,since:new Date(s.statusSince).toISOString().slice(0,10),causa:info.causa||"",responsavel:info.responsavel||"",prioridade:info.prioridade||"media",previsao:info.previsao?new Date(info.previsao).toISOString().slice(0,10):"",observacoes:info.observacoes||""})
    setEditingID(s.stationID);setView("novo");window.scrollTo({top:0,behavior:"smooth"})
  }

  const PRIOR={alta:{label:"Alta",color:C.red,bg:C.redLight,border:"#fecaca"},media:{label:"Média",color:C.yellow,bg:C.yellowLight,border:"#fde68a"},baixa:{label:"Baixa",color:C.blue,bg:C.blueLight,border:C.bluePale}}
  function diasLabel(desde){const d=Math.floor((now-desde)/86400000);if(d===0)return"Hoje";if(d===1)return"1 dia";return`${d} dias`}
  function prevStatus(previsao){if(!previsao)return null;const diff=new Date(previsao).getTime()-now;if(diff<0)return{txt:"Prazo vencido",color:C.red};if(diff<3*86400000)return{txt:"Vence em breve",color:C.yellow};return{txt:new Date(previsao).toLocaleDateString("pt-BR"),color:C.green}}

  const inputSt={fontSize:12,padding:"9px 12px",borderRadius:8,border:`1.5px solid ${C.grayBorder}`,outline:"none",background:C.white,color:C.text,width:"100%",boxSizing:"border-box",fontFamily:"inherit"}
  const labelSt={fontSize:10,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5,display:"block"}

  const fixas    =manut.filter(s=>!s.maintenanceInfo?.dinamica)
  const dinamicas=manut.filter(s=> s.maintenanceInfo?.dinamica)
  const atrasadas=manut.filter(s=>s.maintenanceInfo?.previsao&&new Date(s.maintenanceInfo.previsao).getTime()<now)
  const altaPrior=manut.filter(s=>s.maintenanceInfo?.prioridade==="alta")
  const semPrev  =manut.filter(s=>!s.maintenanceInfo?.previsao)

  function renderCard(s,canEdit){
    const info=s.maintenanceInfo||{},prior=PRIOR[info.prioridade]||PRIOR.media
    const expanded=expandedID===s.stationID,pv=prevStatus(info.previsao)
    const atrasada=info.previsao&&new Date(info.previsao).getTime()<now
    return (
      <Card key={s.stationID} style={{padding:0,overflow:"hidden",border:`1px solid ${prior.border}`}}>
        <div style={{height:3,background:prior.color}}/>
        <div onClick={()=>setExpandedID(expanded?null:s.stationID)}
          style={{background:C.sidebar,padding:"13px 18px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",userSelect:"none"}}>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontSize:14,fontWeight:800,color:"#fff",fontFamily:"monospace"}}>{s.stationID}</span>
              {!canEdit&&<span style={{fontSize:9,padding:"2px 7px",borderRadius:20,background:"rgba(255,255,255,0.15)",color:"rgba(255,255,255,0.7)",fontWeight:700}}>FIXO</span>}
              <span style={{fontSize:10,padding:"2px 9px",borderRadius:20,background:prior.color+"30",color:prior.color,fontWeight:700,border:`1px solid ${prior.color}50`}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:prior.color,display:"inline-block",marginRight:4}}/>{prior.label}
              </span>
              {atrasada&&<span style={{fontSize:10,padding:"2px 9px",borderRadius:20,background:"rgba(220,38,38,0.3)",color:"#fca5a5",fontWeight:700}}>&#x26A0; Prazo vencido</span>}
            </div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.5)",marginTop:3}}>{s.name?.replace(/ZON \([A-Z]+\) /g,"")}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:18}}>
            <div style={{textAlign:"right"}}><div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Em manutenção há</div><div style={{fontSize:15,fontWeight:800,color:"#fff"}}>{diasLabel(s.statusSince)}</div></div>
            <div style={{textAlign:"right"}}><div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>Previsão de retorno</div><div style={{fontSize:12,fontWeight:600,color:pv?pv.color:"rgba(255,255,255,0.5)"}}>{pv?pv.txt:"—"}</div></div>
            <div style={{fontSize:18,color:"rgba(255,255,255,0.35)",transform:expanded?"rotate(90deg)":"rotate(0deg)",transition:"transform .2s"}}>&#x203A;</div>
          </div>
        </div>
        {!expanded&&info.causa&&<div style={{padding:"10px 18px 12px",fontSize:12,color:C.textMid,borderTop:`1px solid ${C.grayBorder}`}}><strong style={{color:C.text}}>Causa:</strong> {info.causa}</div>}
        {expanded&&(
          <div style={{padding:"18px",display:"flex",flexDirection:"column",gap:14}}>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
              {[["Início",fmtDate(s.statusSince)],["Responsável",info.responsavel||"—"],["Previsão de retorno",info.previsao?new Date(info.previsao).toLocaleDateString("pt-BR"):"—"]].map(([k,v])=>(
                <div key={k} style={{background:C.grayLight,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.grayBorder}`}}>
                  <div style={{fontSize:10,color:C.textLight,marginBottom:3}}>{k}</div>
                  <div style={{fontSize:13,fontWeight:600,color:k==="Previsão de retorno"&&atrasada?C.red:C.text}}>{v}</div>
                </div>
              ))}
              <div style={{gridColumn:"span 3",background:C.grayLight,borderRadius:8,padding:"10px 14px",border:`1px solid ${C.grayBorder}`}}>
                <div style={{fontSize:10,color:C.textLight,marginBottom:3}}>Causa / Problema</div>
                <div style={{fontSize:13,fontWeight:600,color:C.text}}>{info.causa||"—"}</div>
              </div>
            </div>
            {info.observacoes&&<div><div style={{fontSize:10,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>Observações</div><div style={{background:C.grayLight,borderRadius:8,padding:"12px 14px",border:`1px solid ${C.grayBorder}`,fontSize:12,color:C.text,whiteSpace:"pre-wrap",lineHeight:1.7}}>{info.observacoes}</div></div>}
            <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,background:C.blueLight,borderRadius:8,padding:"12px 14px",border:`1px solid ${C.bluePale}`}}>
              {[["Último heartbeat",s.lastHeartbeat?ago(s.lastHeartbeat):"—"],["Última transação",s.lastTx?ago(s.lastTx):"—"],["Potência",s.power?`${s.power} kW`:"—"],["Fabricante",s.vendor||"—"]].map(([k,v])=>(
                <div key={k}><div style={{fontSize:10,color:C.textLight,marginBottom:2}}>{k}</div><div style={{fontSize:12,fontWeight:600,color:C.blue}}>{v}</div></div>
              ))}
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:12,borderTop:`1px solid ${C.grayBorder}`}}>
              <div style={{fontSize:11,color:C.textLight}}>{canEdit?`Criado em ${info.criadoEm?new Date(info.criadoEm).toLocaleString("pt-BR"):"—"}`:"Registro fixo do sistema"}</div>
              <div style={{display:"flex",gap:8}}>
                {canEdit&&<button onClick={()=>handleEdit(s)} style={{padding:"8px 18px",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,border:`1.5px solid ${C.orange}`,background:C.orangeLight,color:C.orange}}>&#x270E; Editar</button>}
                {canEdit&&(confirmID===s.stationID?(
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{fontSize:11,color:C.textMid}}>Confirmar?</span>
                    <button onClick={()=>handleRemove(s.stationID)} disabled={removing===s.stationID} style={{padding:"8px 16px",borderRadius:8,fontSize:12,fontWeight:700,border:"none",background:C.green,color:"#fff",cursor:"pointer"}}>{removing===s.stationID?"...":"&#x2713; Sim"}</button>
                    <button onClick={()=>setConfirmID(null)} style={{padding:"8px 14px",borderRadius:8,fontSize:12,fontWeight:600,border:`1.5px solid ${C.grayBorder}`,background:C.white,color:C.textMid,cursor:"pointer"}}>Cancelar</button>
                  </div>
                ):(
                  <button onClick={()=>setConfirmID(s.stationID)} style={{padding:"8px 18px",borderRadius:8,fontSize:12,fontWeight:600,border:`1.5px solid ${C.green}`,background:C.greenLight,color:C.green,cursor:"pointer"}}>&#x2713; Retornou à operação</button>
                ))}
                {!canEdit&&(confirmID===s.stationID?(
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{fontSize:11,color:C.textMid}}>Confirmar retorno?</span>
                    <button onClick={async()=>{try{const res=await fetch(`${API_BASE}/api/manutencoes/fixa/encerrar/${s.stationID}`,{method:"POST"});if(!res.ok)throw new Error("Erro");showFb("ok",`${s.stationID} removida da manutenção.`);setConfirmID(null)}catch(e){showFb("err",e.message)}}} style={{padding:"8px 16px",borderRadius:8,fontSize:12,fontWeight:700,border:"none",background:C.green,color:"#fff",cursor:"pointer"}}>&#x2713; Sim</button>
                    <button onClick={()=>setConfirmID(null)} style={{padding:"8px 14px",borderRadius:8,fontSize:12,fontWeight:600,border:`1.5px solid ${C.grayBorder}`,background:C.white,color:C.textMid,cursor:"pointer"}}>Cancelar</button>
                  </div>
                ):(
                  <button onClick={()=>setConfirmID(s.stationID)} style={{padding:"8px 18px",borderRadius:8,fontSize:12,fontWeight:600,border:`1.5px solid ${C.green}`,background:C.greenLight,color:C.green,cursor:"pointer"}}>&#x2713; Retornou à operação</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </Card>
    )
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {feedback&&<div style={{position:"fixed",top:20,right:24,zIndex:9999,padding:"12px 22px",borderRadius:10,fontWeight:700,fontSize:13,background:feedback.type==="ok"?C.green:C.red,color:"#fff",boxShadow:"0 8px 24px rgba(0,0,0,0.15)"}}>{feedback.type==="ok"?"&#x2713;  ":"&#x2717;  "}{feedback.msg}</div>}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
        <StatCard label="Em manutenção"    value={manut.length}     color={manut.length>0?C.yellow:C.green}   bg={manut.length>0?C.yellowLight:C.greenLight}   sub="agora"/>
        <StatCard label="Alta prioridade"  value={altaPrior.length} color={altaPrior.length>0?C.red:C.green}  bg={altaPrior.length>0?C.redLight:C.greenLight}   sub="urgência"/>
        <StatCard label="Prazo vencido"    value={atrasadas.length} color={atrasadas.length>0?C.red:C.green}  bg={atrasadas.length>0?C.redLight:C.greenLight}   sub="atrasadas"/>
        <StatCard label="Sem previsão"     value={semPrev.length}   color={semPrev.length>0?C.orange:C.green} bg={semPrev.length>0?C.orangeLight:C.greenLight}  sub="sem data"/>
        <StatCard label="Fixas no sistema" value={fixas.length}     color={C.blue}                            bg={C.blueLight}                                  sub="hardcoded"/>
      </div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:`2px solid ${C.grayBorder}`}}>
        <div style={{display:"flex",gap:0}}>
          {[["lista","&#x1F4CB; Manutenções Ativas"],["novo",editingID?`&#x270E; Editando ${editingID}`:"&#x2795; Nova Manutenção"]].map(([id,label])=>(
            <button key={id} onClick={()=>{if(id==="lista"){setEditingID(null);setForm(FORM_EMPTY)}setView(id)}}
              style={{padding:"10px 20px",fontSize:13,fontWeight:view===id?700:500,color:view===id?C.orange:C.textMid,background:"transparent",border:"none",borderBottom:view===id?`2px solid ${C.orange}`:"2px solid transparent",marginBottom:-2,cursor:"pointer"}}
              dangerouslySetInnerHTML={{__html:label}}/>
          ))}
        </div>
        {view==="lista"&&<button onClick={()=>{setForm(FORM_EMPTY);setEditingID(null);setView("novo")}} style={{padding:"8px 20px",borderRadius:8,border:"none",cursor:"pointer",fontWeight:700,fontSize:12,background:C.orange,color:"#fff"}}>+ Nova Manutenção</button>}
      </div>
      {view==="novo"&&(
        <Card style={{border:`2px solid ${C.orange}30`}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:20,paddingBottom:16,borderBottom:`1px solid ${C.grayBorder}`}}>
            <span style={{fontSize:20}}>&#x1F527;</span>
            <div><div style={{fontSize:14,fontWeight:700,color:C.text}}>{editingID?`Editando: ${editingID}`:"Registrar nova manutenção"}</div><div style={{fontSize:12,color:C.textLight,marginTop:2}}>{editingID?"Atualize os campos e salve.":"Preencha as informações."}</div></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16}}>
            <div><label style={labelSt}>Estação *</label>
              {editingID?<div style={{...inputSt,background:C.grayLight,fontFamily:"monospace",fontWeight:700,cursor:"not-allowed",color:C.blue}}>{editingID}</div>:(
                <select value={form.stationID} onChange={e=>setForm(f=>({...f,stationID:e.target.value}))} style={inputSt}>
                  <option value="">Selecione...</option>
                  {disponiveis.map(s=><option key={s.stationID} value={s.stationID}>{s.stationID} — {s.name?.replace(/ZON \([A-Z]+\) /g,"")}</option>)}
                </select>
              )}
            </div>
            <div><label style={labelSt}>Data de início *</label><input type="date" value={form.since} onChange={e=>setForm(f=>({...f,since:e.target.value}))} style={inputSt}/></div>
            <div><label style={labelSt}>Prioridade</label>
              <div style={{display:"flex",gap:6}}>
                {Object.entries(PRIOR).map(([k,p])=>(
                  <button key={k} onClick={()=>setForm(f=>({...f,prioridade:k}))} style={{flex:1,padding:"9px 4px",borderRadius:8,cursor:"pointer",fontWeight:700,fontSize:11,border:`2px solid ${form.prioridade===k?p.color:C.grayBorder}`,background:form.prioridade===k?p.bg:C.white,color:form.prioridade===k?p.color:C.textMid}}>
                    <span style={{width:7,height:7,borderRadius:"50%",background:p.color,display:"inline-block",marginRight:4}}/>{p.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{gridColumn:"span 2"}}><label style={labelSt}>Causa</label><input type="text" value={form.causa} onChange={e=>setForm(f=>({...f,causa:e.target.value}))} placeholder="Ex: Conector danificado..." style={inputSt}/></div>
            <div><label style={labelSt}>Responsável</label><input type="text" value={form.responsavel} onChange={e=>setForm(f=>({...f,responsavel:e.target.value}))} placeholder="Nome ou equipe..." style={inputSt}/></div>
            <div><label style={labelSt}>Previsão de retorno</label><input type="date" value={form.previsao} onChange={e=>setForm(f=>({...f,previsao:e.target.value}))} style={inputSt}/></div>
            <div style={{gridColumn:"span 3"}}><label style={labelSt}>Observações</label><textarea rows={4} value={form.observacoes} onChange={e=>setForm(f=>({...f,observacoes:e.target.value}))} placeholder="Ações tomadas, peças, contatos..." style={{...inputSt,resize:"vertical",lineHeight:1.5}}/></div>
          </div>
          <div style={{marginTop:20,display:"flex",justifyContent:"space-between",paddingTop:16,borderTop:`1px solid ${C.grayBorder}`}}>
            <button onClick={()=>{setView("lista");setForm(FORM_EMPTY);setEditingID(null)}} style={{padding:"9px 20px",borderRadius:8,border:`1.5px solid ${C.grayBorder}`,background:C.white,color:C.textMid,fontWeight:600,fontSize:12,cursor:"pointer"}}>Cancelar</button>
            <button onClick={handleSave} disabled={saving} style={{padding:"9px 28px",borderRadius:8,border:"none",background:saving?C.grayBorder:C.orange,color:"#fff",fontWeight:700,fontSize:13,cursor:saving?"not-allowed":"pointer"}}>{saving?"Salvando...":editingID?"Salvar alterações":"Registrar manutenção"}</button>
          </div>
        </Card>
      )}
      {view==="lista"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {!manut.length&&<Card><div style={{textAlign:"center",padding:"36px 0"}}><div style={{fontSize:40,marginBottom:10}}>&#x2713;</div><div style={{fontSize:15,fontWeight:600,color:C.green}}>Nenhuma estação em manutenção</div></div></Card>}
          {fixas.length>0&&<div><div style={{fontSize:11,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:.5,marginBottom:8}}>Registros fixos ({fixas.length})</div>{fixas.map(s=>renderCard(s,false))}</div>}
          {dinamicas.length>0&&<div style={{marginTop:fixas.length?8:0}}><div style={{fontSize:11,fontWeight:700,color:C.textMid,textTransform:"uppercase",letterSpacing:.5,marginBottom:8}}>Registros manuais ({dinamicas.length})</div>{dinamicas.map(s=>renderCard(s,true))}</div>}
        </div>
      )}
    </div>
  )
}

// ─── ABA: MAPA ────────────────────────────────────────────────────────────────
// Usa Leaflet + OpenStreetMap — gratuito, sem API key, sem cartão de crédito

function TabMap({stations}){
  const mapRef    = useRef(null)
  const leafletRef= useRef(null)
  const markersRef= useRef([])
  const [selected,setSelected] = useState(null)
  const [filter,  setFilter]   = useState("all")

  // Coordenadas das estações ZON (baseadas no nome/cidade)
  const COORDS = {
    "CPZON01":[-5.795,-35.211],"CPZON02":[-5.813,-35.226],"CPZON03":[-3.747,-38.523],
    "CPZON04":[-5.795,-35.211],"CPZON05":[-3.834,-38.539],"CPZON06":[-3.791,-38.506],
    "CPZON07":[-5.198,-37.344],"CPZON08":[-5.795,-35.211],"CPZON09":[-5.795,-35.211],
    "CPZON10":[-5.830,-35.209],"CPZON11":[-5.795,-35.211],"CPZON12":[-5.795,-35.211],
    "CPZON13":[-5.795,-35.211],"CPZON14":[-5.195,-37.344],"CPZON15":[-3.720,-38.543],
    "CPZON16":[-3.805,-38.517],"CPZON17":[-5.795,-35.211],"CPZON18":[-5.795,-35.211],
    "CPZON19":[-5.795,-35.211],"CPZON20":[-5.795,-35.211],"CPZON21":[-5.795,-35.211],
    "CPZON22":[-3.717,-38.541],"CPZON23":[-7.835,-34.880],"CPZON24":[-5.795,-35.211],
    "CPZON25":[-5.795,-35.211],"CPZON26":[-5.795,-35.211],"CPZON27":[-23.186,-45.881],
    "CPZON28":[-23.649,-46.697],"CPZON29":[-5.795,-35.211],"CPZON30":[-5.795,-35.211],
    "CPZON31":[-3.726,-38.654],"CPZON32":[-3.878,-38.634],"CPZON33":[-5.195,-37.344],
    "CPZON35":[-5.795,-35.211],"CPZON36":[-8.104,-34.929],"CPZON38":[-8.162,-34.947],
    "CPZON40":[-5.795,-35.211],"CPZON42":[-5.795,-35.211],"CPZON43":[-5.795,-35.211],
    "CPZON45":[-5.795,-35.211],"CPZON46":[-5.795,-35.211],"CPZON47":[-19.979,-44.199],
    "CPZON48":[-5.795,-35.211],"CPZON49":[-19.980,-44.200],"CPZON50":[-5.795,-35.211],
    "CPZON51":[-5.795,-35.211],"CPZON52":[-8.882,-36.496],"CPZON53":[-5.795,-35.211],
    "CPZON54":[-8.162,-34.947],"CPZON55":[-5.795,-35.211],"CPZON56":[-7.118,-34.862],
    "CPZON57":[-7.118,-34.862],"CPZON58":[-5.795,-35.211],"CPZON60":[-5.795,-35.211],
    "CPZON63":[-5.795,-35.211],"CPZON65":[-8.162,-34.947],"CPZON70":[-7.119,-34.862],
    "CPZON699":[-7.119,-34.863],"CPZON71":[-3.734,-38.507],
  }

  const STATUS_COLOR = {
    operational:"#16a34a", offline:"#dc2626", error:"#f47920",
    maintenance:"#1a4fa0", unavailable:"#d97706", unknown:"#9ca3af"
  }

  const filtered = stations.filter(s => filter==="all" || s.status===filter)

  useEffect(()=>{
    // Carrega Leaflet via CDN se ainda não carregado
    if(!window.L){
      const link = document.createElement("link")
      link.rel = "stylesheet"
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
      document.head.appendChild(link)

      const script = document.createElement("script")
      script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
      script.onload = () => initMap()
      document.head.appendChild(script)
    } else {
      initMap()
    }

    function initMap(){
      if(!mapRef.current || leafletRef.current) return
      const L = window.L
      const map = L.map(mapRef.current, {
        center: [-7.0, -38.5],
        zoom: 6,
        zoomControl: true,
      })
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
        attribution:'© <a href="https://openstreetmap.org">OpenStreetMap</a>',
        maxZoom:19
      }).addTo(map)
      leafletRef.current = map
    }

    return ()=>{}
  },[])

  // Atualiza marcadores quando stations ou filter mudam
  useEffect(()=>{
    const L = window.L
    if(!L || !leafletRef.current) return
    const map = leafletRef.current

    // Remove marcadores antigos
    markersRef.current.forEach(m => map.removeLayer(m))
    markersRef.current = []

    filtered.forEach(s=>{
      const coords = COORDS[s.stationID]
      if(!coords) return
      const color = STATUS_COLOR[s.status] || "#9ca3af"
      const icon = L.divIcon({
        className:"",
        html:`<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4)"></div>`,
        iconSize:[14,14],
        iconAnchor:[7,7],
      })
      const marker = L.marker(coords, {icon})
        .addTo(map)
        .bindPopup(`
          <div style="font-family:system-ui;min-width:180px">
            <div style="font-weight:800;font-size:13px;color:#1a4fa0;margin-bottom:4px">${s.stationID}</div>
            <div style="font-size:12px;color:#374151;margin-bottom:8px">${s.name?.replace(/ZON \([A-Z]+\) /g,"")??"—"}</div>
            <div style="display:flex;align-items:center;gap:6px">
              <div style="width:8px;height:8px;border-radius:50%;background:${color}"></div>
              <span style="font-size:11px;font-weight:600;color:${color}">${s.status}</span>
            </div>
            ${s.totalCargas>0?`<div style="font-size:11px;color:#6b7280;margin-top:4px">${s.totalCargas} cargas · ${s.taxaSucesso}% sucesso</div>`:""}
            ${s.power?`<div style="font-size:11px;color:#6b7280">${s.power} kW · ${s.vendor||"—"}</div>`:""}
          </div>
        `)
        .on("click",()=>setSelected(s))
      markersRef.current.push(marker)
    })
  },[filtered.map(s=>s.stationID+s.status).join()])

  const counts = {}
  stations.forEach(s=>{ counts[s.status]=(counts[s.status]??0)+1 })

  return (
    <div style={{display:"flex",flexDirection:"column",gap:12}}>

      {/* KPIs */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:12}}>
        {[
          ["operational","Operantes",  C.green,  C.greenLight ],
          ["offline",    "Offline",    C.red,    C.redLight   ],
          ["error",      "Em erro",    C.orange, C.orangeLight],
          ["unavailable","Indispon.",  C.yellow, C.yellowLight],
          ["maintenance","Manutenção", C.blue,   C.blueLight  ],
        ].map(([status,label,color,bg])=>(
          <div key={status} onClick={()=>setFilter(f=>f===status?"all":status)}
            style={{background:filter===status?bg:C.white,borderRadius:10,padding:"14px 16px",
              border:`2px solid ${filter===status?color:C.grayBorder}`,cursor:"pointer",
              transition:"all .15s",textAlign:"center"}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:STATUS_COLOR[status],margin:"0 auto 6px"}}/>
            <div style={{fontSize:22,fontWeight:800,color}}>{counts[status]??0}</div>
            <div style={{fontSize:11,color:C.textLight,marginTop:2}}>{label}</div>
          </div>
        ))}
      </div>

      {/* Mapa */}
      <Card style={{padding:0,overflow:"hidden",height:520}}>
        <div ref={mapRef} style={{width:"100%",height:"100%"}}/>
      </Card>

      {/* Legenda */}
      <div style={{display:"flex",gap:16,flexWrap:"wrap",justifyContent:"center",fontSize:11,color:C.textMid}}>
        {Object.entries(STATUS_COLOR).map(([status,color])=>(
          <div key={status} style={{display:"flex",alignItems:"center",gap:5}}>
            <div style={{width:10,height:10,borderRadius:"50%",background:color,border:"1px solid rgba(0,0,0,0.2)"}}/>
            <span>{status}</span>
          </div>
        ))}
        <span style={{color:C.textLight}}>· Clique no marcador para detalhes · Mapa: OpenStreetMap</span>
      </div>

    </div>
  )
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function App(){
  const {stations,connected,source,lastUpdate}=useStations()
  const [tab,setTab]=useState("dashboard")
  const [detail,setDetail]=useState(null)

  if(!connected&&stations.length===0) return (
    <div style={{background:C.sidebar,minHeight:"100vh",display:"flex",
      alignItems:"center",justifyContent:"center",
      fontFamily:"'Inter','Segoe UI',sans-serif"}}>
      <div style={{textAlign:"center"}}>
        <div style={{marginBottom:20,display:"flex",justifyContent:"center"}}>
          <ZonLogo size={40}/>
        </div>
        <div style={{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:4}}>
          Aguardando conexão com o backend...
        </div>
        <div style={{fontSize:12,color:"rgba(255,255,255,0.3)"}}>
          <code style={{color:C.orange}}>npm run dev</code> na pasta <code style={{color:C.orange}}>backend/</code>
        </div>
      </div>
    </div>
  )

  const critical=stations.filter(s=>["offline","error"].includes(s.status)).length

  return (
    <div style={{display:"flex",minHeight:"100vh",fontFamily:"'Inter','Segoe UI',sans-serif",
      background:C.bg,color:C.text}}>

      {/* SIDEBAR */}
      <div style={{width:220,background:C.sidebar,display:"flex",flexDirection:"column",
        flexShrink:0,position:"fixed",top:0,left:0,bottom:0,zIndex:50,
        boxShadow:"2px 0 12px rgba(0,0,0,0.15)"}}>

        {/* Logo */}
        <div style={{padding:"20px 20px 16px",borderBottom:`1px solid ${C.sidebarBorder}`}}>
          <ZonLogo size={36}/>
        </div>

        {/* Nav */}
        <nav style={{flex:1,padding:"12px 10px",overflowY:"auto"}}>
          <div style={{fontSize:9,fontWeight:700,color:"rgba(255,255,255,0.35)",
            letterSpacing:"0.12em",textTransform:"uppercase",
            padding:"0 10px",marginBottom:8,marginTop:4}}>Principal</div>
          {TABS.map(t=>{
            const active=tab===t.id
            const alertCount=t.id==="alerts"?critical:0
            return (
              <button key={t.id} onClick={()=>setTab(t.id)} style={{
                display:"flex",alignItems:"center",justifyContent:"space-between",
                width:"100%",padding:"9px 12px",borderRadius:8,marginBottom:2,
                fontSize:13,fontWeight:active?600:400,
                color:active?"#fff":"rgba(255,255,255,0.6)",
                background:active?C.sidebarActive:"transparent",
                borderLeft:active?`3px solid ${C.orange}`:"3px solid transparent",
                border:"none",cursor:"pointer",textAlign:"left",transition:"all 0.15s",
              }}
              onMouseEnter={e=>{ if(!active) e.currentTarget.style.background=C.sidebarHover }}
              onMouseLeave={e=>{ if(!active) e.currentTarget.style.background="transparent" }}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <span style={{fontSize:14,opacity:0.9}}>{t.icon}</span>
                  <span>{t.label}</span>
                </div>
                {alertCount>0&&(
                  <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",
                    borderRadius:10,background:C.red,color:"#fff"}}>
                    {alertCount}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        {/* Rodapé */}
        <div style={{padding:"12px 16px",borderTop:`1px solid ${C.sidebarBorder}`}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,
              background:source==="sse"?C.green:C.yellow,
              boxShadow:source==="sse"?`0 0 6px ${C.green}`:"none"}}/>
            <div>
              <div style={{fontSize:11,color:"#fff",fontWeight:600}}>
                {source==="sse"?"Tempo real (SSE)":source==="poll"?"Polling":"Conectando..."}
              </div>
              <div style={{fontSize:10,color:"rgba(255,255,255,0.4)"}}>
                {lastUpdate?fmtTime(lastUpdate):"—"}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* CONTEÚDO */}
      <div style={{marginLeft:220,flex:1,display:"flex",flexDirection:"column",minWidth:0}}>

        {/* Header */}
        <div style={{background:C.white,borderBottom:`1px solid ${C.grayBorder}`,
          padding:"0 28px",height:58,display:"flex",alignItems:"center",
          justifyContent:"space-between",position:"sticky",top:0,zIndex:40,
          boxShadow:"0 1px 4px rgba(0,0,0,0.05)"}}>
          <div>
            <div style={{fontSize:16,fontWeight:700,color:C.text}}>
              {TABS.find(t=>t.id===tab)?.label}
            </div>
            <div style={{fontSize:11,color:C.textLight}}>
              {stations.length} estações monitoradas
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {critical>0&&(
              <div style={{display:"flex",alignItems:"center",gap:6,
                padding:"5px 14px",borderRadius:20,
                background:C.redLight,border:`1px solid #fecaca`}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:C.red,
                  boxShadow:`0 0 5px ${C.red}`}}/>
                <span style={{fontSize:12,fontWeight:700,color:C.red}}>
                  {critical} crítico{critical>1?"s":""}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Conteúdo da aba */}
        <div style={{padding:"24px 28px",flex:1,overflowY:"auto"}}>
          {tab==="dashboard"   && <TabDashboard    stations={stations}/>}
          {tab==="stations"    && <TabStations     stations={stations} onSelect={setDetail}/>}
          {tab==="alerts"      && <TabAlerts       stations={stations}/>}
          {tab==="charges"     && <TabCharges      stations={stations}/>}
          {tab==="availability" && <TabAvailability stations={stations}/>}
          {tab==="maintenance" && <TabMaintenance  stations={stations}/>}
          {tab==="map"         && <TabMap          stations={stations}/>}
        </div>
      </div>

      {detail&&<DetailModal station={detail} onClose={()=>setDetail(null)}/>}
    </div>
  )
}