"use strict";

const PAGE_SIZE = 25;
const state = {
  mode: "trips",
  trips: [], oneway: [], tripsTotal: 0, tripsCapped: false,
  sortKey: "effective", sortDir: 1,
  page: 1, selected: null,
  chat: [], chatBusy: false,
  favs: [], favKeys: new Set(),
  calMonth: null, calOut: {}, calIn: {}, calDir: "outbound", calSel: null,
};
// $ and the theme/sidebar shell live in shell.js (loaded first).
const fmtEUR = v => v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const fmtEUR0 = v => Math.round(v).toLocaleString("es-ES") + " €";
const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const LABELS_ES = {
  "weekend": "finde", "fri evening": "viernes tarde", "weekday": "entre semana",
  "work hours": "horario laboral", "early": "madrugón", "ok": "ok",
};
const labelES = l => l.split(", ").map(p => LABELS_ES[p] || p).join(" · ");
function badgeClass(label) {
  if (label.includes("work hours")) return "warn";
  if (label.includes("weekend") || label.includes("fri evening")) return "good";
  return "";
}
const badges = l => `<span class="badges">` +
  l.split(", ").map(p => `<span class="badge ${badgeClass(p)}">${LABELS_ES[p] || p}</span>`).join("") +
  `</span>`;
const stopsES = n => !n ? "directo" : n === 1 ? "1 escala" : `${n} escalas`;

function whenCell(iso, dateOnly) {
  const d = new Date(iso);
  const day = `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  // Luxair fares carry no departure time; show nothing rather than a fake 00:00.
  const time = dateOnly
    ? `<span class="time" style="color:var(--muted)">sin hora</span>`
    : `<span class="time">${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}</span>`;
  return `<span class="when"><span class="day">${day}</span>${time}</span>`;
}
function fmtDep(iso) {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function legCell(origin, destination, airline, stops) {
  return `<span class="leg"><span class="code">${origin}<span class="arr">→</span>${destination}</span>` +
    `<span class="op">${airline || "–"} · <span class="${stops ? "" : "direct"}">${stopsES(stops)}</span></span></span>`;
}

// ---------- favourites ----------

const favKeyOf = f => [f.kind, f.out_origin, f.out_destination, f.out_departure,
  f.ret_origin || "", f.ret_destination || "", f.ret_departure || ""].join("|");

const tripFav = t => ({
  kind: t.package ? "package" : "trip",
  out_origin: t.out.origin, out_destination: "ALC", out_departure: t.out.departure,
  ret_origin: "ALC", ret_destination: t.ret.destination, ret_departure: t.ret.departure,
  price_at_save: t.price,
});
const flightFav = f => ({
  kind: "flight",
  out_origin: f.origin, out_destination: f.destination, out_departure: f.departure,
  ret_origin: null, ret_destination: null, ret_departure: null,
  price_at_save: f.price,
});

async function loadFavs() {
  const data = await (await fetch("/api/favorites")).json();
  state.favs = data.favorites;
  state.favKeys = new Set(data.favorites.map(f => f.key));
  $("favCount").textContent = state.favs.length ? `(${state.favs.length})` : "";
}

async function toggleFav(fav) {
  const key = favKeyOf(fav);
  const on = state.favKeys.has(key);
  await fetch("/api/favorites", {
    method: on ? "DELETE" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fav),
  });
  await loadFavs();
  if (state.mode === "favs") renderFavs(); else render();
  renderChat();
}

function starCell(fav) {
  const on = state.favKeys.has(favKeyOf(fav));
  return `<td class="starcol"><button class="star ${on ? "on" : ""}" title="${
    on ? "Quitar de favoritos" : "Guardar en favoritos"}">${on ? "★" : "☆"}</button></td>`;
}

// ---------- data ----------

function tripQuery() {
  const p = new URLSearchParams({
    min_nights: $("fMinN").value || "0",
    max_nights: $("fMaxN").value || "60",
  });
  if ($("fAirport").value) p.set("airport", $("fAirport").value);
  if ($("fWhen").value) p.set("when", $("fWhen").value);
  if ($("fSame").checked) p.set("same_airport", "1");
  if ($("fDirect").checked) p.set("direct", "1");
  if ($("fMax").value) p.set("max_price", $("fMax").value);
  return p.toString();
}

async function loadTrips() {
  const res = await fetch(`/api/trips?${tripQuery()}`);
  const data = await res.json();
  state.trips = data.trips;
  state.tripsTotal = data.total;
  state.tripsCapped = data.capped;
}

async function load() {
  const fData = await (await fetch("/api/flights")).json();
  state.oneway = fData.flights.map(f => ({ ...f, route: `${f.origin}→${f.destination}` }));

  if (fData.last_captured) {
    const d = new Date(fData.last_captured);
    $("lastCaptured").textContent =
      `actualizado ${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  }

  const airports = [...new Set(
    state.oneway.map(f => f.destination === "ALC" ? f.origin : f.destination)
  )].filter(a => a !== "ALC").sort();
  for (const a of airports) {
    const o = document.createElement("option");
    o.value = a; o.textContent = a;
    $("fAirport").appendChild(o);
  }
  await Promise.all([loadTrips(), loadFavs()]);
  setMode(modeFromHash());
  checkChat();
}

// The docs page links back as /#calendar etc., so honour the hash on arrival
// and when it changes.
const MODES = ["trips", "oneway", "calendar", "favs"];
const modeFromHash = () => {
  const m = location.hash.replace("#", "");
  return MODES.includes(m) ? m : "trips";
};
window.addEventListener("hashchange", () => setMode(modeFromHash()));

async function setMode(mode) {
  const toTrips = mode === "trips" && state.mode !== "trips";
  state.mode = mode;
  state.page = 1; state.selected = null;
  state.sortKey = "effective"; state.sortDir = 1;
  const TITLES = { trips: "Ida y vuelta", oneway: "Solo ida",
                   calendar: "Calendario", favs: "Favoritos" };
  for (const [id, m] of [["tabTrips","trips"], ["tabOneway","oneway"],
                         ["tabCalendar","calendar"], ["tabFavs","favs"]]) {
    $(id).classList.toggle("active", mode === m);
  }
  $("viewTitle").textContent = TITLES[mode] || "";
  const isTable = mode === "trips" || mode === "oneway";
  $("tableView").style.display = isTable ? "" : "none";
  $("calendarView").style.display = mode === "calendar" ? "" : "none";
  $("favsView").style.display = mode === "favs" ? "" : "none";
  $("toolbar").style.display = mode === "favs" ? "none" : "";
  document.querySelector(".tiles").style.display =
    (mode === "favs" || mode === "calendar") ? "none" : "";
  $("lNights").style.display = mode === "trips" ? "" : "none";
  $("lSame").style.display = mode === "trips" ? "" : "none";
  $("lSource").style.display = mode === "oneway" ? "" : "none";
  for (const id of ["fWhen", "fMax"]) {
    $(id).closest("label").style.display = mode === "calendar" ? "none" : "";
  }
  $("lDirect").style.display = mode === "calendar" ? "none" : "";
  $("calDirWrap").style.display = mode === "calendar" ? "" : "none";
  $("detail").classList.remove("open");

  if (mode === "favs") { await loadFavs(); renderFavs(); return; }
  if (mode === "calendar") { await loadCalendar(); renderCalendar(); return; }
  renderHead();
  if (toTrips) await loadTrips();
  renderTiles();
  render();
}

// ---------- calendar ----------

async function loadCalendar() {
  const p = new URLSearchParams();
  if ($("fAirport").value) p.set("airport", $("fAirport").value);
  const data = await (await fetch(`/api/calendar?${p}`)).json();
  state.calOut = Object.fromEntries(data.outbound.map(d => [d.day, d.price]));
  state.calIn = Object.fromEntries(data.inbound.map(d => [d.day, d.price]));
  if (!state.calMonth) {
    const now = new Date();
    state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
}

// Sequential blue ramp (light->dark = cheap->expensive is inverted here:
// cheap should stand out, so cheap = strong accent, expensive = faint).
const CAL_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];

function renderCalendar() {
  const days = state.calDir === "outbound" ? state.calOut : state.calIn;
  const prices = Object.values(days);
  $("calTitle").textContent = state.calDir === "outbound"
    ? "Precio más bajo por día — ida hacia Alicante"
    : "Precio más bajo por día — vuelta desde Alicante";

  $("calRamp").innerHTML = CAL_RAMP.map(c => `<i style="background:${c}"></i>`).join("");

  const lo = prices.length ? Math.min(...prices) : 0;
  const hi = prices.length ? Math.max(...prices) : 1;
  const colorFor = p => {
    if (hi === lo) return CAL_RAMP[0];
    // Log scale: fares cluster low with a long expensive tail.
    const t = (Math.log(p) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    return CAL_RAMP[Math.min(CAL_RAMP.length - 1, Math.floor(t * CAL_RAMP.length))];
  };

  const host = $("calMonths");
  host.innerHTML = "";
  for (let i = 0; i < 2; i++) {
    const base = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + i, 1);
    host.appendChild(monthGrid(base, days, colorFor));
  }
}

function monthGrid(base, days, colorFor) {
  const el = document.createElement("div");
  el.className = "month";
  const label = base.toLocaleDateString("es-ES", { month: "long", year: "numeric" });
  const first = (new Date(base.getFullYear(), base.getMonth(), 1).getDay() + 6) % 7; // Mon=0
  const total = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();

  let cells = "";
  for (let i = 0; i < first; i++) cells += `<div class="day blank"></div>`;
  for (let d = 1; d <= total; d++) {
    const iso = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const price = days[iso];
    const dow = new Date(base.getFullYear(), base.getMonth(), d).getDay();
    const wknd = dow === 0 || dow === 6 ? " wknd" : "";
    if (price === undefined) {
      cells += `<div class="day none${wknd}"><span class="n">${d}</span></div>`;
    } else {
      const bg = colorFor(price);
      const dark = CAL_RAMP.indexOf(bg) >= 3;
      cells += `<div class="day has${wknd}${state.calSel === iso ? " sel" : ""}" data-day="${iso}"
        style="background:${bg};color:${dark ? "#fff" : "#0b0b0b"}"
        title="${iso} · ${fmtEUR(price)}">
        <span class="n">${d}</span><span class="p">${Math.round(price)}€</span></div>`;
    }
  }
  el.innerHTML = `<h3>${label}</h3>
    <div class="dow"><div>lu</div><div>ma</div><div>mi</div><div>ju</div><div>vi</div><div>sá</div><div>do</div></div>
    <div class="days">${cells}</div>`;
  el.querySelectorAll(".day.has").forEach(d => {
    d.addEventListener("click", () => selectCalDay(d.dataset.day));
  });
  return el;
}

async function selectCalDay(iso) {
  state.calSel = iso;
  // Jump to the trips list filtered to that departure date.
  state.calDepart = iso;
  await setMode("trips");
  state.trips = state.trips.filter(t => t.out.departure.startsWith(iso));
  $("rowCount").textContent = `${state.trips.length} viajes saliendo el ${iso}`;
  render();
}

// ---------- favourites ----------

function renderFavs() {
  const host = $("favGrid");
  if (!state.favs.length) {
    host.innerHTML = `<div class="chat-empty" style="grid-column:1/-1;padding:30px 0">
      Todavía no has guardado nada. Pulsa la ☆ en cualquier vuelo o viaje —
      o pídeselo al asistente y guarda su recomendación.</div>`;
    return;
  }
  host.innerHTML = "";
  for (const f of state.favs) {
    const el = document.createElement("div");
    el.className = "fav";
    const legs = f.legs.map(l => {
      const price = l.price == null
        ? (f.package ? "" : "—") : fmtEUR(l.price);
      const range = (l.low != null && l.high != null && l.high > l.low)
        ? ` <span style="color:var(--muted)">(${Math.round(l.low)}–${Math.round(l.high)})</span>` : "";
      const d = new Date(l.departure);
      const when = l.date_only
        ? `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · sin hora`
        : fmtDep(l.departure);
      return `<div class="leg">
        <span class="l">${l.origin} → ${l.destination}<br>
          <span style="color:var(--muted);font-size:11.5px">${when} · ${l.airline || "?"}</span></span>
        <span class="r">${price}${range}</span></div>`;
    }).join("");
    const nights = f.legs.length === 2
      ? Math.round((new Date(f.legs[1].departure) - new Date(f.legs[0].departure)) / 86400000)
      : null;
    let delta = "";
    if (f.delta != null && Math.abs(f.delta) >= 0.5) {
      const down = f.delta < 0;
      delta = `<span class="delta ${down ? "down" : "up"}">${down ? "▼" : "▲"} ${
        fmtEUR(Math.abs(f.delta))}</span>`;
    }
    el.innerHTML = `
      <button class="rm" title="Quitar">✕</button>
      <h3>${f.legs[0].origin} → ${f.legs[0].destination}${
        f.legs.length === 2 ? ` → ${f.legs[1].destination}` : ""}</h3>
      <div class="sub">${nights != null ? `${nights} noches · ` : ""}guardado ${
        f.created_at.slice(0, 10)}</div>
      ${legs}
      <div class="total"><span style="color:var(--ink-2);font-size:12.5px">total ahora</span>
        <span><span class="v">${f.price_now != null ? fmtEUR(f.price_now) : "—"}</span> ${delta}</span></div>`;
    el.querySelector(".rm").addEventListener("click", () => toggleFav({
      kind: f.kind, out_origin: f.out_origin, out_destination: f.out_destination,
      out_departure: f.out_departure, ret_origin: f.ret_origin,
      ret_destination: f.ret_destination, ret_departure: f.ret_departure,
    }));
    host.appendChild(el);
  }
}

const COLS = {
  trips: [
    { k: "_star", t: "", star: true },
    { k: "out_route", t: "Ida" }, { k: "out_dep", t: "Salida" },
    { k: "ret_route", t: "Vuelta" }, { k: "ret_dep", t: "Regreso" },
    { k: "nights", t: "Noches", num: true },
    { k: "price", t: "Precio", num: true },
    { k: "adjustment", t: "Ajuste", num: true },
    { k: "effective", t: "Efectivo", num: true },
    { k: "when", t: "Cuándo" },
  ],
  oneway: [
    { k: "_star", t: "", star: true },
    { k: "route", t: "Vuelo" }, { k: "departure", t: "Salida" },
    { k: "price", t: "Precio", num: true },
    { k: "adjustment", t: "Ajuste", num: true },
    { k: "effective", t: "Efectivo", num: true },
    { k: "label", t: "Cuándo" }, { k: "source", t: "Fuente" },
  ],
};

function renderHead() {
  const tr = $("theadRow");
  tr.innerHTML = "";
  for (const c of COLS[state.mode]) {
    const th = document.createElement("th");
    th.dataset.k = c.k;
    if (c.num) th.classList.add("num");
    if (c.star) { th.classList.add("starcol"); tr.appendChild(th); continue; }
    th.innerHTML = `${c.t}<span class="arrow"></span>`;
    th.addEventListener("click", () => {
      if (state.sortKey === c.k) state.sortDir *= -1;
      else { state.sortKey = c.k; state.sortDir = 1; }
      state.page = 1;
      render();
    });
    tr.appendChild(th);
  }
}

function renderTiles() {
  if (state.mode === "trips") {
    const ts = state.trips;
    $("tileBestK").textContent = "Mejor viaje";
    $("tileCheapK").textContent = "Más barato";
    $("tileCountK").textContent = "Combinaciones";
    if (!ts.length) {
      $("tileBest").textContent = "–"; $("tileBestDetail").textContent = "sin resultados";
      $("tileCheapest").textContent = "–"; $("tileCheapestDetail").textContent = "";
      $("tileCount").textContent = "0"; $("tileCountDetail").textContent = "prueba a relajar los filtros";
      return;
    }
    const best = ts[0], cheap = [...ts].sort((a, b) => a.price - b.price)[0];
    $("tileBest").textContent = fmtEUR0(best.effective);
    $("tileBestDetail").textContent =
      `${best.out.origin}→ALC ${fmtDep(best.out.departure)} · ${best.nights} noches · ${fmtEUR0(best.price)} real`;
    $("tileCheapest").textContent = fmtEUR0(cheap.price);
    $("tileCheapestDetail").textContent =
      `${cheap.out.origin}→ALC ${fmtDep(cheap.out.departure)} · ${cheap.nights} noches`;
    $("tileCount").textContent = (state.tripsTotal ?? ts.length).toLocaleString("es-ES");
    $("tileCountDetail").textContent = state.tripsCapped
      ? `mostrando las ${ts.length.toLocaleString("es-ES")} mejores`
      : "idas × vueltas emparejadas";
  } else {
    const fs = state.oneway;
    $("tileBestK").textContent = "Mejor vuelo";
    $("tileCheapK").textContent = "Más barato";
    $("tileCountK").textContent = "Tarifas futuras";
    if (!fs.length) return;
    const best = [...fs].sort((a, b) => a.effective - b.effective)[0];
    const cheap = [...fs].sort((a, b) => a.price - b.price)[0];
    $("tileBest").textContent = fmtEUR0(best.effective);
    $("tileBestDetail").textContent = `${best.route} · ${fmtDep(best.departure)}`;
    $("tileCheapest").textContent = fmtEUR0(cheap.price);
    $("tileCheapestDetail").textContent = `${cheap.route} · ${fmtDep(cheap.departure)}`;
    $("tileCount").textContent = fs.length.toLocaleString("es-ES");
    $("tileCountDetail").textContent = [...new Set(fs.map(f => f.route))].length + " rutas trackeadas";
  }
}

function matchWhen(label, when) {
  if (!when) return true;
  if (when === "weekend") return label.includes("weekend");
  if (when === "fri") return label.includes("fri evening");
  if (when === "convenient") return label.includes("weekend") || label.includes("fri evening");
  if (when === "weekday") return label.includes("weekday") || label.includes("work hours");
  return true;
}

// Trips arrive already filtered by /api/trips (see the endpoint's docstring).
const filteredTrips = () => state.trips;

function filteredOneway() {
  const ap = $("fAirport").value, when = $("fWhen").value,
        source = $("fSource").value, max = parseFloat($("fMax").value),
        direct = $("fDirect").checked;
  return state.oneway.filter(f => {
    if (ap && f.origin !== ap && f.destination !== ap) return false;
    if (source && f.source !== source) return false;
    if (direct && f.stops) return false;
    if (!isNaN(max) && f.price > max) return false;
    if (!matchWhen(f.label, when)) return false;
    return true;
  });
}

function sortVal(item, k) {
  if (state.mode === "trips") {
    switch (k) {
      case "out_route": return item.out.origin;
      case "out_dep": return item.out.departure;
      case "ret_route": return item.ret.destination;
      case "ret_dep": return item.ret.departure;
      case "when": return item.out.label;
      default: return item[k];
    }
  }
  return item[k];
}

function render() {
  const all = state.mode === "trips" ? filteredTrips() : filteredOneway();
  all.sort((a, b) => {
    const av = sortVal(a, state.sortKey), bv = sortVal(b, state.sortKey);
    return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * state.sortDir;
  });

  document.querySelectorAll("#tbl th").forEach(th => {
    const arrow = th.querySelector(".arrow");   // the star column has none
    if (arrow) {
      arrow.textContent =
        th.dataset.k === state.sortKey ? (state.sortDir === 1 ? "▲" : "▼") : "";
    }
  });

  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const rows = all.slice(start, start + PAGE_SIZE);

  const tbody = $("tbody");
  tbody.innerHTML = "";
  if (!rows.length) {
    const cols = COLS[state.mode].length;
    tbody.innerHTML = `<tr><td class="empty-row" colspan="${cols}">Ningún resultado con estos filtros.</td></tr>`;
  }
  for (const item of rows) {
    const tr = document.createElement("tr");
    if (state.selected === item) tr.classList.add("selected");
    tr.innerHTML = state.mode === "trips" ? tripRow(item) : onewayRow(item);
    tr.addEventListener("click", ev => {
      if (ev.target.closest(".star")) {
        ev.stopPropagation();
        toggleFav(state.mode === "trips" ? tripFav(item) : flightFav(item));
        return;
      }
      state.mode === "trips" ? selectTrip(item) : selectFlight(item);
    });
    tbody.appendChild(tr);
  }

  $("rowCount").textContent = `${all.length.toLocaleString("es-ES")} ${state.mode === "trips" ? "viajes" : "vuelos"}`;
  renderPager(all.length, pages);
}

function tripRow(t) {
  return starCell(tripFav(t)) + `
    <td>${legCell(t.out.origin, "ALC", t.out.airline, t.out.stops)}</td>
    <td>${whenCell(t.out.departure, t.out.date_only)}</td>
    <td>${legCell("ALC", t.ret.destination, t.ret.airline, t.ret.stops)}</td>
    <td>${whenCell(t.ret.departure, t.ret.date_only)}</td>
    <td class="num">${t.nights}</td>
    <td class="num">${fmtEUR(t.price)}${t.package ? ' <span class="badge">paq.</span>' : ""}</td>
    <td class="num adj">${t.adjustment > 0 ? "+" : ""}${t.adjustment.toFixed(0)} €</td>
    <td class="num"><span class="eff">${fmtEUR(t.effective)}</span></td>
    <td>${badges(t.out.label)}</td>`;
}

function onewayRow(f) {
  return starCell(flightFav(f)) + `
    <td>${legCell(f.origin, f.destination, f.airline, f.stops)}</td>
    <td>${whenCell(f.departure)}</td>
    <td class="num">${fmtEUR(f.price)}</td>
    <td class="num adj">${f.adjustment > 0 ? "+" : ""}${f.adjustment.toFixed(0)} €</td>
    <td class="num"><span class="eff">${fmtEUR(f.effective)}</span></td>
    <td>${badges(f.label)}</td>
    <td><span class="src">${f.source}</span></td>`;
}

function renderPager(total, pages) {
  const start = total ? (state.page - 1) * PAGE_SIZE + 1 : 0;
  const end = Math.min(state.page * PAGE_SIZE, total);
  $("pageInfo").textContent = total
    ? `${start}–${end} de ${total.toLocaleString("es-ES")}` : "";
  const host = $("pageBtns");
  host.innerHTML = "";
  const btn = (label, page, opts = {}) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (opts.current) b.classList.add("current");
    if (opts.disabled) b.disabled = true;
    else b.addEventListener("click", () => {
      state.page = page; render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    host.appendChild(b);
  };
  if (pages <= 1) return;
  btn("‹", state.page - 1, { disabled: state.page === 1 });
  for (const n of pageNumbers(state.page, pages)) {
    if (n === "…") {
      const s = document.createElement("span");
      s.className = "ellip"; s.textContent = "…";
      host.appendChild(s);
    } else btn(String(n), n, { current: n === state.page });
  }
  btn("›", state.page + 1, { disabled: state.page === pages });
}

function pageNumbers(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out = [1];
  if (cur > 3) out.push("…");
  for (let n = Math.max(2, cur - 1); n <= Math.min(total - 1, cur + 1); n++) out.push(n);
  if (cur < total - 2) out.push("…");
  out.push(total);
  return out;
}

// ---------- detail / chart ----------

async function fetchHistory(origin, destination, departure) {
  const day = departure.slice(0, 10);
  const res = await fetch(`/api/history?origin=${origin}&destination=${destination}&day=${day}`);
  const data = await res.json();
  const exact = data.points.filter(p => p.departure === departure);
  return (exact.length ? exact : data.points)
    .map(p => ({ t: new Date(p.captured_at).getTime(), price: p.price }))
    .sort((a, b) => a.t - b.t);
}

async function selectFlight(f) {
  state.selected = f;
  render();
  openDetail(`${f.origin} → ${f.destination} · ${fmtDep(f.departure)}`,
    `${f.airline || "?"} · ${stopsES(f.stops)} · ${fmtEUR(f.price)} · evolución del precio`, false);
  drawChart([{ pts: await fetchHistory(f.origin, f.destination, f.departure),
               color: "--series-1", name: "precio" }]);
}

async function selectTrip(t) {
  state.selected = t;
  render();
  openDetail(
    `${t.out.origin} → ALC → ${t.ret.destination} · ${t.nights} noches`,
    `Ida ${fmtDep(t.out.departure)} (${t.out.airline || "?"}) · vuelta ${fmtDep(t.ret.departure)} ` +
    `(${t.ret.airline || "?"}) · total ${fmtEUR(t.price)}`, true);
  const [o, r] = await Promise.all([
    fetchHistory(t.out.origin, "ALC", t.out.departure),
    fetchHistory("ALC", t.ret.destination, t.ret.departure),
  ]);
  drawChart([
    { pts: o, color: "--series-1", name: "ida" },
    { pts: r, color: "--series-2", name: "vuelta" },
  ]);
}

function openDetail(title, meta, legend) {
  $("detail").classList.add("open");
  $("dTitle").textContent = title;
  $("dMeta").textContent = meta;
  $("dLegend").style.display = legend ? "" : "none";
  $("chartHost").innerHTML = `<div class="empty">Cargando…</div>`;
  $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeDetail() {
  state.selected = null;
  $("detail").classList.remove("open");
  render();
}

function drawChart(seriesList) {
  const host = $("chartHost");
  seriesList = seriesList.filter(s => s.pts.length);
  if (!seriesList.length) {
    host.innerHTML = `<div class="empty">Sin histórico todavía. Cada <code>fetch</code> añade un punto.</div>`;
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const C = n => css.getPropertyValue(n).trim();
  const W = host.clientWidth || 900, H = 220;
  const m = { top: 14, right: 16, bottom: 26, left: 54 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;

  const allPts = seriesList.flatMap(s => s.pts);
  const ts = allPts.map(p => p.t), ps = allPts.map(p => p.price);
  const t0 = Math.min(...ts), t1 = Math.max(...ts);
  let p0 = Math.min(...ps), p1 = Math.max(...ps);
  if (p0 === p1) { p0 -= 5; p1 += 5; }
  const pad = (p1 - p0) * 0.15; p0 -= pad; p1 += pad;
  const X = t => t1 === t0 ? m.left + iw / 2 : m.left + (t - t0) / (t1 - t0) * iw;
  const Y = p => m.top + (1 - (p - p0) / (p1 - p0)) * ih;

  let grid = "", yLabels = "";
  for (let i = 0; i <= 4; i++) {
    const v = p0 + (p1 - p0) * i / 4, y = Y(v);
    grid += `<line x1="${m.left}" y1="${y}" x2="${W - m.right}" y2="${y}" stroke="${C("--grid")}" stroke-width="1"/>`;
    yLabels += `<text x="${m.left - 9}" y="${y + 4}" text-anchor="end" font-size="11" fill="${C("--muted")}">${Math.round(v)} €</text>`;
  }
  const fmtT = t => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  let xLabels = "";
  const shown = new Set();
  for (const t of [...new Set(ts)].sort((a, b) => a - b)) {
    const lbl = fmtT(t);
    if (shown.has(lbl)) continue;
    shown.add(lbl);
    xLabels += `<text x="${X(t)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="${C("--muted")}">${lbl}</text>`;
  }

  let paths = "";
  for (const s of seriesList) {
    const line = s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.price).toFixed(1)}`).join(" ");
    paths += `<path d="${line}" fill="none" stroke="${C(s.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of s.pts) {
      paths += `<circle cx="${X(p.t)}" cy="${Y(p.price)}" r="4" fill="${C(s.color)}" stroke="${C("--surface")}" stroke-width="2"/>`;
    }
  }

  host.innerHTML = `
    <svg id="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del precio">
      ${grid}
      <line x1="${m.left}" y1="${m.top + ih}" x2="${W - m.right}" y2="${m.top + ih}" stroke="${C("--baseline")}" stroke-width="1"/>
      ${yLabels}${xLabels}${paths}
      <line id="xhair" y1="${m.top}" y2="${m.top + ih}" stroke="${C("--baseline")}" stroke-width="1" style="display:none"/>
    </svg>`;

  const svg = host.querySelector("svg"), xhair = svg.querySelector("#xhair"), tip = $("tooltip");
  const times = [...new Set(ts)].sort((a, b) => a - b);
  svg.addEventListener("mousemove", ev => {
    const rect = svg.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (W / rect.width);
    let bt = times[0], bd = Infinity;
    for (const t of times) { const d = Math.abs(X(t) - mx); if (d < bd) { bd = d; bt = t; } }
    xhair.setAttribute("x1", X(bt)); xhair.setAttribute("x2", X(bt));
    xhair.style.display = "";
    const d = new Date(bt);
    let html = `<div class="t">${d.getDate()} ${MONTHS[d.getMonth()]} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}</div>`;
    for (const s of seriesList) {
      const p = s.pts.find(p => p.t === bt);
      if (p) html += `<div class="p">${seriesList.length > 1 ? s.name + ": " : ""}${fmtEUR(p.price)}</div>`;
    }
    tip.innerHTML = html;
    tip.style.display = "block";
    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - 160) + "px";
    tip.style.top = (ev.clientY + 14) + "px";
  });
  svg.addEventListener("mouseleave", () => {
    xhair.style.display = "none"; tip.style.display = "none";
  });
}

// ---------- chat ----------

const SUGGESTIONS = [
  "¿Cuál es el mejor finde para ir a Alicante?",
  "¿Compensa salir desde LUX o mejor Ryanair desde HHN?",
  "Quiero 4 noches sin pedir día libre. ¿Qué me recomiendas?",
  "¿Han bajado los precios desde la última captura?",
];

/* The assistant emits one marker line per option it recommends; we turn those
   into cards with a save button instead of showing the raw marker. */
const MARKER_RE = /^\[(TRIP|FLIGHT|PACKAGE)\]\s*(.+)$/;

function parseMarker(line) {
  const m = line.trim().match(MARKER_RE);
  if (!m) return null;
  const parts = m[2].split("|").map(s => s.trim());
  if (m[1] === "TRIP" && parts.length === 4) {
    const [oa, od, ra, rd] = parts;
    if (!oa || !od || !ra || !rd) return null;
    return { kind: "trip", out_origin: oa, out_destination: "ALC", out_departure: od,
             ret_origin: "ALC", ret_destination: ra, ret_departure: rd };
  }
  if (m[1] === "PACKAGE" && parts.length === 4) {
    const [origin, dest, day, nights] = parts;
    const n = parseInt(nights, 10);
    if (!origin || !dest || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !(n > 0)) return null;
    const back = new Date(`${day}T00:00:00`);
    back.setDate(back.getDate() + n);
    const backIso = back.toISOString().slice(0, 10);
    return { kind: "package", out_origin: origin, out_destination: dest,
             out_departure: `${day}T00:00:00`, ret_origin: dest,
             ret_destination: origin, ret_departure: `${backIso}T00:00:00` };
  }
  if (m[1] === "FLIGHT" && parts.length === 3) {
    const [o, d, dep] = parts;
    if (!o || !d || !dep) return null;
    return { kind: "flight", out_origin: o, out_destination: d, out_departure: dep,
             ret_origin: null, ret_destination: null, ret_departure: null };
  }
  return null;
}

function tripCard(fav) {
  const el = document.createElement("div");
  el.className = "tripcard";
  const on = state.favKeys.has(favKeyOf(fav));
  const round = fav.kind === "trip" || fav.kind === "package";
  const pkg = fav.kind === "package";
  const title = round
    ? `${fav.out_origin} → ${fav.out_destination} → ${fav.ret_destination}` +
      (pkg ? ` · Luxair` : "")
    : `${fav.out_origin} → ${fav.out_destination}`;
  const day = iso => {
    const d = new Date(iso);
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  };
  let when;
  try {
    if (pkg) {
      const nights = Math.round(
        (new Date(fav.ret_departure) - new Date(fav.out_departure)) / 86400000);
      when = `Ida ${day(fav.out_departure)} · vuelta ${day(fav.ret_departure)}` +
             `<br>${nights} noches · sin horas publicadas`;
    } else if (round) {
      when = `Ida ${fmtDep(fav.out_departure)}<br>Vuelta ${fmtDep(fav.ret_departure)}`;
    } else {
      when = fmtDep(fav.out_departure);
    }
  } catch { when = fav.out_departure; }
  el.innerHTML = `<div class="r">${title}</div><div class="d">${when}</div>
    <div class="act"><button class="${on ? "on" : ""}">${on ? "★ Guardado" : "☆ Guardar"}</button></div>`;
  el.querySelector("button").addEventListener("click", () => toggleFav(fav));
  return el;
}

/* Minimal markdown for chat replies. Escapes HTML first, so model output can
   never inject markup. Handles bold/italic/code, bullet lists, rules. */
function mdToHtml(src) {
  const esc = s => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const inline = s => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
  for (const line of src.split("\n")) {
    const t = line.trim();
    if (!t) { flush(); continue; }
    if (/^([-*_])\1{2,}$/.test(t)) { flush(); out.push("<hr>"); continue; }
    const h = t.match(/^#{1,6}\s+(.*)$/);
    if (h) { flush(); out.push(`<p class="h">${inline(h[1])}</p>`); continue; }
    // Markers become cards; a half-streamed one is hidden rather than shown raw.
    if (/^\[(TRIP|FLIGHT)\]/.test(t)) { flush(); continue; }
    const li = t.match(/^[*\-•]\s+(.*)$/);
    if (li) { (list ??= []).push(`<li>${inline(li[1])}</li>`); continue; }
    flush();
    out.push(`<p>${inline(t)}</p>`);
  }
  flush();
  return out.join("");
}

async function checkChat() {
  try {
    const s = await (await fetch("/api/chat/status")).json();
    $("chatDot").classList.toggle("off", !s.ready);
    state.chatReady = s.ready;
    state.chatReason = s.reason;
    state.chatModel = s.model;
    if (s.ready) $("chatDot").title = `${s.provider} · ${s.model}`;
  } catch { state.chatReady = false; }
  renderChat();
}

function renderChat() {
  const log = $("chatLog");
  if (!state.chat.length) {
    log.innerHTML = `<div class="chat-empty">
      ${state.chatReady
        ? `Pregúntame sobre tus vuelos. Veo el snapshot actual de precios, las combinaciones de ida y vuelta y el histórico.<br><span style="font-size:11.5px">modelo: ${state.chatModel || "?"}</span>`
        : `<b>Chat no disponible.</b><br>${state.chatReason || "Falta configurar la API de Claude."}`}
      </div>`;
    if (state.chatReady) {
      const box = document.createElement("div");
      box.className = "suggestions";
      for (const s of SUGGESTIONS) {
        const b = document.createElement("button");
        b.textContent = s;
        b.addEventListener("click", () => { $("chatInput").value = s; sendChat(); });
        box.appendChild(b);
      }
      log.appendChild(box);
    }
    return;
  }
  log.innerHTML = "";
  for (const m of state.chat) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}${m.error ? " error" : ""}`;
    div.innerHTML = `<div class="who">${m.role === "user" ? "tú" : "asistente"}</div>` +
                    `<div class="body"></div>`;
    const body = div.querySelector(".body");
    if (m.role === "user" || m.error) {
      body.textContent = m.content;
    } else {
      // Split the reply around marker lines so each option gets a save card
      // right where the model put it.
      let buf = [];
      const flushText = () => {
        if (!buf.length) return;
        body.insertAdjacentHTML("beforeend", mdToHtml(buf.join("\n")));
        buf = [];
      };
      for (const line of m.content.split("\n")) {
        const fav = parseMarker(line);
        if (fav) { flushText(); body.appendChild(tripCard(fav)); }
        else buf.push(line);
      }
      flushText();
    }
    if (m.streaming) body.insertAdjacentHTML("beforeend", '<span class="typing"></span>');
    log.appendChild(div);
  }
  log.scrollTop = log.scrollHeight;
}

async function sendChat() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text || state.chatBusy) return;
  input.value = ""; input.style.height = "auto";
  state.chat.push({ role: "user", content: text });
  const reply = { role: "assistant", content: "", streaming: true };
  state.chat.push(reply);
  state.chatBusy = true;
  $("chatSend").disabled = true;
  renderChat();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.chat
          .filter(m => !m.streaming && !m.error)
          .map(m => ({ role: m.role, content: m.content })),
      }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6);
        if (raw === "[DONE]") continue;
        const evt = JSON.parse(raw);
        if (evt.error) { reply.content = evt.error; reply.error = true; }
        else reply.content += evt.text;
        renderChat();
      }
    }
  } catch (err) {
    reply.content = `Error de conexión: ${err.message}`;
    reply.error = true;
  }
  reply.streaming = false;
  state.chatBusy = false;
  $("chatSend").disabled = false;
  renderChat();
}

function toggleChat(force) {
  const open = force ?? !$("chat").classList.contains("open");
  $("chat").classList.toggle("open", open);
  $("chatToggle").classList.toggle("on", open);
  if (open) setTimeout(() => $("chatInput").focus(), 180);
}

// ---------- events ----------

$("tabTrips").addEventListener("click", () => setMode("trips"));
$("tabOneway").addEventListener("click", () => setMode("oneway"));
$("tabCalendar").addEventListener("click", () => setMode("calendar"));
$("tabFavs").addEventListener("click", () => setMode("favs"));
$("calDir").addEventListener("change", e => {
  state.calDir = e.target.value; renderCalendar();
});
$("calPrev").addEventListener("click", () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$("calNext").addEventListener("click", () => {
  state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
  renderCalendar();
});
$("dClose").addEventListener("click", closeDetail);
$("chatToggle").addEventListener("click", () => toggleChat());
$("chatClose").addEventListener("click", () => toggleChat(false));
$("chatClear").addEventListener("click", () => { state.chat = []; renderChat(); });
$("chatForm").addEventListener("submit", e => { e.preventDefault(); sendChat(); });
$("chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
$("chatInput").addEventListener("input", e => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + "px";
});

let filterTimer = null;
function onFilterChange() {
  state.page = 1;
  if (state.mode === "calendar") {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(async () => { await loadCalendar(); renderCalendar(); }, 200);
    return;
  }
  if (state.mode === "favs") return;
  if (state.mode !== "trips") { render(); return; }
  clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    await loadTrips();
    renderTiles();
    render();
  }, 200);
}
for (const id of ["fAirport", "fWhen", "fSource", "fMax", "fSame", "fDirect", "fMinN", "fMaxN"]) {
  $(id).addEventListener("input", onFilterChange);
}


// Redraw anything painted with resolved colours when the theme changes.
window.onThemeChange = () => {
  if (state.selected && $("detail").classList.contains("open")) {
    state.mode === "trips" ? selectTrip(state.selected) : selectFlight(state.selected);
  }
  if (state.mode === "calendar") renderCalendar();
};

load();
