import { useState, useRef } from "react";

// ─── ALL CODE BELOW IS IDENTICAL TO CALCULATOR ────────────────────────────────

const SEC_TYPES = {
  stock:     { label: "Stock",     color: "#3b82f6", bg: "#3b82f615" },
  reit:      { label: "REIT",      color: "#8b5cf6", bg: "#8b5cf615" },
  bond:      { label: "Bond/ETF",  color: "#06b6d4", bg: "#06b6d415" },
  preferred: { label: "Preferred", color: "#10b981", bg: "#10b98115" },
  cd:        { label: "MM/CD",     color: "#f59e0b", bg: "#f59e0b15" },
};

const FREQ = [
  { id:"monthly",    label:"Monthly",                     months:[1,2,3,4,5,6,7,8,9,10,11,12] },
  { id:"q_jan",      label:"Quarterly (Jan-Apr-Jul-Oct)",  months:[1,4,7,10] },
  { id:"q_feb",      label:"Quarterly (Feb-May-Aug-Nov)",  months:[2,5,8,11] },
  { id:"q_mar",      label:"Quarterly (Mar-Jun-Sep-Dec)",  months:[3,6,9,12] },
  { id:"semi_jan",   label:"Semi-Annual (Jan + Jul)",      months:[1,7] },
  { id:"semi_feb",   label:"Semi-Annual (Feb + Aug)",      months:[2,8] },
  { id:"annual_dec", label:"Annual (December)",            months:[12] },
  { id:"annual_jun", label:"Annual (June)",                months:[6] },
];

const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const fmt = (n, d=0) => n == null ? "--" :
  new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",minimumFractionDigits:d,maximumFractionDigits:d}).format(n);

const parseNum = s => parseFloat(String(s||"0").replace(/[$,%\s,"()]/g,"")) || 0;

function splitLine(line) {
  const out = []; let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQ = !inQ; }
    else if (line[i] === "," && !inQ) { out.push(cur.trim()); cur = ""; }
    else { cur += line[i]; }
  }
  out.push(cur.trim());
  return out;
}

function parseCSV(text) {
  const lines = text.replace(/\r/g,"").split("\n").filter(l => l.trim());
  let hi = 0;
  for (let i = 0; i < Math.min(15, lines.length); i++) {
    const low = lines[i].replace(/"/g,"").toLowerCase();
    if (low.startsWith("symbol") || low.startsWith("ticker") || low.startsWith("instrument") || low.includes(",symbol,")) {
      hi = i; break;
    }
  }
  const headers = splitLine(lines[hi]).map(h => h.replace(/"/g,"").trim());
  const rows = [];
  for (let i = hi+1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = splitLine(lines[i]);
    const row = {};
    headers.forEach((h,j) => { row[h] = (vals[j]||"").replace(/"/g,"").trim(); });
    const sym = row["Symbol"] || row["symbol"] || row["Ticker"] || "";
    if (!sym || sym === "--" || sym.toLowerCase().includes("total") || sym.toLowerCase().includes("cash")) continue;
    rows.push(row);
  }
  return rows;
}

function getShares(row) {
  const key = Object.keys(row).find(k => /qty|quantity|shares/i.test(k));
  return key ? row[key] : "0";
}

// Exact aiLookup from calculator — not one character changed
async function aiLookup(ticker, onResult, onError, onLoad) {
  onLoad(true);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514", max_tokens:400,
        messages:[{role:"user",content:
          'What is the current dividend per share per payment for "' + ticker + '"? ' +
          'Also what is the payment frequency and security type? ' +
          'Reply ONLY with raw JSON, no markdown: ' +
          '{"name":"full name","type":"stock|reit|bond|preferred|cd","divPerShare":0.00,"freqId":"monthly|q_jan|q_feb|q_mar|semi_jan|semi_feb|annual_dec|annual_jun","notes":"brief"} ' +
          'or {"error":"not found"}'
        }]
      })
    });
    const d = await r.json();
    const txt = (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").replace(/```json|```/g,"").trim();
    const j = JSON.parse(txt);
    if (j.error) throw new Error(j.error);
    onResult(j);
  } catch(e) { onError(e.message||"Failed"); }
  finally { onLoad(false); }
}

// ─── DIVIDEND FINDER — only difference from calculator: shows ONLY problem tickers ──

function getCandidates(ticker) {
  const t = ticker.toUpperCase();
  const candidates = new Set();
  if (t.endsWith("/PR")) { candidates.add(t.slice(0,-3)); candidates.add(t.slice(0,-3)+"P"); }
  if (t.endsWith("-PR")) { candidates.add(t.slice(0,-3)); candidates.add(t.slice(0,-3)+"P"); }
  if (t.includes("/")) candidates.add(t.replace("/","-"));
  if (t.includes("-")) candidates.add(t.replace("-","/"));
  const base = t.replace(/[/-]PR$/,"").replace(/[/-]P[A-Z]?$/,"");
  ["P","PA","PB","PC"].forEach(s => candidates.add(base+s));
  candidates.add(base);
  candidates.delete(t);
  return [...candidates].filter(Boolean);
}

export default function App() {
  const [holdings, setHoldings]       = useState([]);
  const [problems, setProblems]       = useState([]);
  const [running, setRunning]         = useState(false);
  const [bulkStatus, setBulkStatus]   = useState("");
  const [done, setDone]               = useState(false);
  const [rawText, setRawText]         = useState("");
  const fileRef = useRef();

  const handleFile = e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result;
      setRawText(text);
      try {
        const rows = parseCSV(text);
        const mapped = rows.map((r,i) => ({
          id: Date.now()+i,
          ticker: (r["Symbol"]||r["symbol"]||r["Ticker"]||"").replace(/\s/g,"").toUpperCase(),
          name: (r["Description"]||r["description"]||r["Name"]||r["Investment Name"]||"").trim(),
          shares: parseNum(getShares(r)),
          type: "stock",
          divPerShare: 0,
          freqId: "q_mar",
          notes: "needs-lookup",
        })).filter(r => r.ticker && r.ticker.length >= 1 && r.ticker.length <= 12 && r.shares > 0);
        if (!mapped.length) { alert("No positions found. Please use a CSV positions export from your brokerage."); return; }
        setHoldings(mapped);
        setProblems([]);
        setDone(false);
        setBulkStatus("");
      } catch(err) { alert("Could not read file: " + err.message); }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Exact bulk lookup from calculator — runs all tickers, collects problems
  const bulkLookup = async () => {
    const missing = holdings.filter(h => !h.divPerShare || h.notes === "needs-lookup");
    if (!missing.length) { setDone(true); return; }
    setRunning(true);
    const foundProblems = [];
    let done_count = 0;

    for (const h of missing) {
      setBulkStatus(done_count + "/" + missing.length + " - looking up " + h.ticker + "...");
      await new Promise(res => {
        const timer = setTimeout(() => {
          // Timed out — this is a problem ticker
          foundProblems.push({ ...h, status: "red", suggestion: null, manualDiv: "", altTicker: "" });
          done_count++; res();
        }, 30000);
        aiLookup(
          h.ticker,
          d => {
            clearTimeout(timer);
            // Found — update holdings silently, not shown to user
            setHoldings(p => p.map(x => x.id === h.id ? {
              ...x, ...d, ticker: x.ticker, shares: x.shares, notes: ""
            } : x));
            done_count++; res();
          },
          () => {
            clearTimeout(timer);
            // Error — problem ticker
            foundProblems.push({ ...h, status: "red", suggestion: null, manualDiv: "", altTicker: "" });
            done_count++; res();
          },
          () => {}
        );
      });
      await new Promise(r => setTimeout(r, 300));
    }

    // Now silently try alternatives for each problem ticker
    setBulkStatus("Resolving " + foundProblems.length + " problem ticker(s)...");
    for (let i = 0; i < foundProblems.length; i++) {
      const p = foundProblems[i];
      const candidates = getCandidates(p.ticker);
      let resolved = false;
      for (const candidate of candidates) {
        await new Promise(res => {
          aiLookup(
            candidate,
            d => {
              if (d.divPerShare > 0) {
                foundProblems[i] = { ...p, status: "yellow", suggestion: { ticker: candidate, ...d } };
                resolved = true;
              }
              res();
            },
            () => res(),
            () => {}
          );
        });
        if (resolved) break;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    setProblems(foundProblems);
    setRunning(false);
    setDone(true);
    setBulkStatus("");
  };

  const acceptSuggestion = id => {
    setProblems(p => p.map(x => {
      if (x.id !== id || !x.suggestion) return x;
      // Update the holding with the confirmed ticker and dividend
      setHoldings(h => h.map(hx => hx.id === id ? {
        ...hx, ticker: x.suggestion.ticker, divPerShare: x.suggestion.divPerShare,
        freqId: x.suggestion.freqId, type: x.suggestion.type, notes: ""
      } : hx));
      return { ...x, status: "green", altTicker: x.suggestion.ticker };
    }));
  };

  const setManualDiv = (id, val) => {
    setProblems(p => p.map(x => {
      if (x.id !== id) return x;
      const v = parseFloat(val);
      if (v > 0) {
        setHoldings(h => h.map(hx => hx.id === id ? { ...hx, divPerShare: v, notes: "" } : hx));
        return { ...x, manualDiv: val, status: "green" };
      }
      return { ...x, manualDiv: val };
    }));
  };

  const exportCSV = () => {
    const lines = rawText.replace(/\r/g,"").split("\n");
    let hi = 0;
    for (let i = 0; i < Math.min(15, lines.length); i++) {
      const low = lines[i].replace(/"/g,"").toLowerCase();
      if (low.startsWith("symbol") || low.includes(",symbol,")) { hi = i; break; }
    }
    // Build ticker map — use accepted alternative tickers where applicable
    const tickerMap = {};
    holdings.forEach(h => { tickerMap[h.ticker] = h.ticker; });
    problems.forEach(p => {
      if (p.altTicker) tickerMap[p.ticker] = p.altTicker;
    });
    const head = lines.slice(0, hi+1).join("\n");
    const body = lines.slice(hi+1).filter(l => l.trim()).map(l => {
      const sym = l.split(",")[0].replace(/"/g,"").trim().toUpperCase();
      const mapped = tickerMap[sym];
      if (mapped && mapped !== sym) return l.replace(sym, mapped);
      return l;
    });
    const out = head + "\n" + body.join("\n");
    const blob = new Blob([out], {type:"text/csv"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "dividend-finder-corrected.csv"; a.click();
  };

  const allResolved = problems.length > 0 && problems.every(p => p.status === "green");
  const needsLookup = holdings.filter(h => !h.divPerShare || h.notes === "needs-lookup").length;

  return (
    <div style={{minHeight:"100vh",background:"#f1f5f9",fontFamily:"'Outfit',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Outfit:wght@400;500;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#f1f5f9}
        .lbtn{background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:8px;padding:7px 12px;font-family:'Outfit',sans-serif;font-weight:600;font-size:12px;cursor:pointer}
        .lbtn:disabled{opacity:.4;cursor:not-allowed}
        .ibtn{background:#fff;color:#1e293b;border:1px solid #cbd5e1;border-radius:8px;padding:7px 12px;font-family:'Outfit',sans-serif;font-weight:600;font-size:12px;cursor:pointer}
        .ibtn:hover{border-color:#3b82f6;color:#3b82f6}
        .rbtn{background:#fff;color:#94a3b8;border:1px solid #e2e8f0;border-radius:8px;padding:7px 12px;font-family:'Outfit',sans-serif;font-size:12px;cursor:pointer}
        .accept-btn{background:#10b98115;border:1px solid #10b98144;color:#10b981;border-radius:8px;padding:6px 14px;font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
        .accept-btn:hover{background:#10b98125}
        .exp-btn{background:#3b82f6;color:#fff;border:none;border-radius:10px;padding:11px 24px;font-family:'Outfit',sans-serif;font-weight:700;font-size:13px;cursor:pointer}
        .exp-btn:hover{background:#2563eb}
        .manual-inp{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;color:#1e293b;font-family:'DM Mono',monospace;font-size:12px;padding:6px 10px;width:130px;outline:none}
        .manual-inp:focus{border-color:#8b5cf6}
        .upload-zone{border:2px dashed #cbd5e1;border-radius:16px;padding:60px 40px;text-align:center;cursor:pointer;transition:all .25s;background:#fff}
        .upload-zone:hover{border-color:#10b981;background:#f0fdf4}
        .bstat{font-family:'DM Mono',monospace;font-size:11px;color:#10b981;background:#f0fdf4;border:1px solid #bbf7d0;padding:4px 9px;border-radius:8px}
      `}</style>

      {/* Header — same as calculator */}
      <div style={{background:"#fff",borderBottom:"2px solid #e2e8f0",padding:"14px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{fontSize:28,fontWeight:900,color:"#10b981"}}>$</div>
          <div>
            <div style={{fontSize:18,fontWeight:800,letterSpacing:"-.02em"}}>Dividend Finder</div>
            <div style={{fontSize:11,color:"#64748b",marginTop:1}}>Step 1 — Find and fix problem tickers before running the calculator</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          {needsLookup > 0 && !done && (
            <button className="lbtn" onClick={bulkLookup} disabled={running}>
              {running ? "Running..." : `Lookup ${needsLookup} tickers`}
            </button>
          )}
          {bulkStatus && <span className="bstat">{bulkStatus}</span>}
          {holdings.length > 0 && (
            <button className="ibtn" onClick={() => fileRef.current?.click()}>Import CSV</button>
          )}
          {holdings.length > 0 && (
            <button className="rbtn" onClick={() => {setHoldings([]);setProblems([]);setDone(false);}}>Reset</button>
          )}
        </div>
      </div>

      <div style={{maxWidth:900,margin:"0 auto",padding:"24px 16px 60px"}}>
        <input ref={fileRef} type="file" accept=".csv" style={{display:"none"}} onChange={handleFile}/>

        {holdings.length === 0 ? (
          <div className="upload-zone" onClick={() => fileRef.current?.click()}>
            <div style={{fontSize:40,marginBottom:12}}>📂</div>
            <div style={{fontWeight:700,fontSize:18,color:"#1e293b",marginBottom:6}}>Upload Your Brokerage CSV</div>
            <div style={{fontSize:13,color:"#64748b"}}>Schwab, Fidelity, Vanguard — same file you use in the Portfolio Calculator</div>
          </div>

        ) : !done ? (
          <div style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:12,padding:"32px",textAlign:"center",boxShadow:"0 1px 3px #0000000a"}}>
            <div style={{fontSize:36,marginBottom:12}}>🔍</div>
            <div style={{fontWeight:700,fontSize:18,marginBottom:8}}>{holdings.length} positions loaded</div>
            <div style={{color:"#64748b",fontSize:13,marginBottom:24}}>Click the yellow button above to look up dividends for all tickers. Only problem tickers will be shown.</div>
            {running && bulkStatus && (
              <div style={{fontFamily:"'DM Mono',monospace",fontSize:12,color:"#10b981",background:"#f0fdf4",border:"1px solid #bbf7d0",padding:"8px 16px",borderRadius:8,display:"inline-block"}}>{bulkStatus}</div>
            )}
          </div>

        ) : problems.length === 0 ? (
          // All clean — no problems found
          <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:12,padding:"32px",textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:12}}>✅</div>
            <div style={{fontWeight:700,fontSize:20,color:"#15803d",marginBottom:8}}>All {holdings.length} tickers confirmed</div>
            <div style={{color:"#166534",fontSize:13,marginBottom:24}}>Every position returned valid dividend data. Your CSV is ready to use in the Portfolio Calculator as-is.</div>
            <div style={{color:"#15803d",fontSize:12,fontFamily:"'DM Mono',monospace"}}>No corrections needed — use your original CSV file in the calculator.</div>
          </div>

        ) : (
          // Show only problem tickers
          <>
            <div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:10,padding:"14px 18px",marginBottom:20,display:"flex",gap:12,alignItems:"flex-start"}}>
              <span style={{fontSize:20,flexShrink:0}}>⚠️</span>
              <div>
                <div style={{fontWeight:700,color:"#dc2626",fontSize:14}}>
                  {problems.filter(p=>p.status==="red").length > 0
                    ? `${problems.filter(p=>p.status==="red").length} ticker${problems.filter(p=>p.status==="red").length>1?"s":""} could not be found`
                    : "All problems resolved — ready to export"}
                </div>
                <div style={{fontSize:12,color:"#991b1b",marginTop:3}}>
                  {problems.filter(p=>p.status==="green").length} of {problems.length} resolved.
                  {allResolved ? " Download the corrected CSV and run it in the Portfolio Calculator." : " Accept a suggestion or enter the dividend manually for each red ticker."}
                </div>
              </div>
            </div>

            <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
              {problems.map(p => (
                <div key={p.id} style={{background:"#fff",border:`1px solid ${p.status==="green"?"#bbf7d0":p.status==="yellow"?"#fcd34d33":"#fecaca"}`,borderRadius:12,padding:"18px 20px",boxShadow:"0 1px 3px #0000000a"}}>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <span style={{fontSize:20}}>{p.status==="green"?"✅":p.status==="yellow"?"💡":"❌"}</span>
                      <div>
                        <div style={{fontFamily:"'DM Mono',monospace",fontWeight:600,fontSize:16,color:p.status==="green"?"#15803d":p.status==="yellow"?"#92400e":"#dc2626"}}>
                          {p.ticker}
                          {p.altTicker && <span style={{fontSize:12,color:"#64748b",marginLeft:8}}>→ using {p.altTicker}</span>}
                        </div>
                        <div style={{fontSize:12,color:"#64748b",marginTop:2}}>{p.name}</div>
                      </div>
                    </div>
                    <div style={{fontSize:12,color:"#94a3b8",fontFamily:"'DM Mono',monospace"}}>{p.shares.toLocaleString()} shares</div>
                  </div>

                  {/* Yellow — pre-verified suggestion */}
                  {p.status === "yellow" && p.suggestion && (
                    <div style={{marginTop:14,background:"#f0fdf4",border:"1px solid #10b98133",borderRadius:8,padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:10}}>
                      <div style={{fontSize:13}}>
                        <span style={{color:"#64748b"}}>Try </span>
                        <span style={{fontFamily:"'DM Mono',monospace",fontWeight:700,color:"#10b981",fontSize:14}}>{p.suggestion.ticker}</span>
                        <span style={{color:"#64748b"}}> instead</span>
                        <span style={{margin:"0 8px",color:"#e2e8f0"}}>·</span>
                        <span style={{fontFamily:"'DM Mono',monospace",color:"#10b981"}}>{fmt(p.suggestion.divPerShare,4)}/pmt</span>
                        <span style={{margin:"0 8px",color:"#e2e8f0"}}>·</span>
                        <span style={{color:"#64748b",fontSize:12}}>{p.suggestion.freqId}</span>
                        <span style={{margin:"0 8px",color:"#e2e8f0"}}>·</span>
                        <span style={{fontSize:11,color:"#10b981"}}>pre-verified ✓</span>
                      </div>
                      <button className="accept-btn" onClick={() => acceptSuggestion(p.id)}>
                        Accept → Use {p.suggestion.ticker}
                      </button>
                    </div>
                  )}

                  {/* Red — no suggestion found, manual entry */}
                  {p.status === "red" && (
                    <div style={{marginTop:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                      <span style={{fontSize:13,color:"#64748b"}}>Enter dividend per payment manually:</span>
                      <input
                        className="manual-inp"
                        type="number" min="0" step="0.0001"
                        placeholder="e.g. 0.3438"
                        value={p.manualDiv}
                        onChange={e => setManualDiv(p.id, e.target.value)}
                      />
                      {p.manualDiv && parseFloat(p.manualDiv) > 0 && (
                        <span style={{fontSize:12,color:"#10b981"}}>✓ Will be applied</span>
                      )}
                    </div>
                  )}

                  {/* Green — resolved */}
                  {p.status === "green" && (
                    <div style={{marginTop:10,fontSize:12,color:"#15803d",fontFamily:"'DM Mono',monospace"}}>
                      ✓ Resolved — {p.altTicker ? `using ${p.altTicker}` : `manual entry: ${fmt(parseFloat(p.manualDiv),4)}/pmt`}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {allResolved && (
              <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:12,padding:"20px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontWeight:700,color:"#1d4ed8",fontSize:14}}>All problems resolved — CSV is ready</div>
                  <div style={{fontSize:12,color:"#3730a3",marginTop:4}}>Download the corrected CSV and import it into the Portfolio Calculator.</div>
                </div>
                <button className="exp-btn" onClick={exportCSV}>↓ Download Corrected CSV</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
