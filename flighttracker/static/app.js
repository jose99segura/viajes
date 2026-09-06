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
  group: true, openGroups: new Set(),
  alerts: [], alertEditing: null, userPicked: false, alertView: {},
};
// $ and the theme/sidebar shell live in shell.js (loaded first).
const fmtEUR = v => v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
const fmtEUR0 = v => Math.round(v).toLocaleString("es-ES") + " €";
const DAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const LABELS_ES = {
  "weekend": "finde", "fri evening": "viernes tarde", "weekday": "entre semana",
  "work hours": "horario laboral", "early": "madrugón", "ok": "ok",
  "late arrival": "llegada de noche",
};
const labelES = l => l.split(", ").map(p => LABELS_ES[p] || p).join(" · ");
function badgeClass(label) {
  if (label.includes("work hours") || label.includes("late arrival")) return "warn";
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


// ---------- booking links ----------
//
// Ryanair's own deep-link format (originIata/destinationIata/dateOut/dateIn)
// is stable and widely used, so we can prefill it exactly. Luxair's booking
// engine has no documented deep-link parameters and sits behind bot
// protection (see /info) — we only know the real luxair.lu URL works, not
// how to prefill it, so that link is honest about needing manual dates.
// Anything else (Google-sourced fares, mixed-source pairings) falls back to
// a Google Flights search query, which resolves for any airport pair.

function _bookDay(iso) { return iso.slice(0, 10); }

function bookingLinkForLeg(source, origin, destination, departureIso, returnIso) {
  const dateOut = _bookDay(departureIso);
  if (source === "ryanair") {
    const p = new URLSearchParams({
      adults: "1", teens: "0", children: "0", infants: "0",
      dateOut, isConnectedFlight: "false", discount: "0", promoCode: "",
      originIata: origin, destinationIata: destination,
      isReturn: returnIso ? "true" : "false",
    });
    if (returnIso) p.set("dateIn", _bookDay(returnIso));
    return {
      label: returnIso ? "Reservar ida y vuelta · Ryanair" : "Reservar · Ryanair",
      url: `https://www.ryanair.com/es/es/trip/flights/select?${p}`,
    };
  }
  if (source === "luxair") {
    return {
      label: "Buscar en luxair.lu",
      url: "https://www.luxair.lu/en",
      muted: true,
      title: `Luxair no permite enlazar la búsqueda ya rellena — se abre su web, ` +
             `introduce ${origin} → ${destination} el ${dateOut}.`,
    };
  }
  const q = returnIso
    ? `Flights from ${origin} to ${destination} on ${dateOut} through ${_bookDay(returnIso)}`
    : `Flights from ${origin} to ${destination} on ${dateOut}`;
  return {
    label: "Buscar en Google Flights",
    url: `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`,
    muted: true,
  };
}

// One-way flight -> a single link. Round trip -> one combined Ryanair link
// when both legs are Ryanair (its own flow searches both at once), otherwise
// one link per leg since a single URL can't span two different sites.
function bookingLinksFor(item, isTrip) {
  if (!isTrip) {
    return [bookingLinkForLeg(item.source, item.origin, item.destination, item.departure)];
  }
  if (item.package) {
    return [bookingLinkForLeg("luxair", item.out.origin, item.out.destination, item.out.departure)];
  }
  if (item.out.source === "ryanair" && item.ret.source === "ryanair") {
    return [bookingLinkForLeg("ryanair", item.out.origin, "ALC", item.out.departure, item.ret.departure)];
  }
  return [
    bookingLinkForLeg(item.out.source, item.out.origin, "ALC", item.out.departure),
    bookingLinkForLeg(item.ret.source, "ALC", item.ret.destination, item.ret.departure),
  ];
}

function bookingLinksHtml(links, size) {
  const cls = size === "small" ? "book-link small" : "book-link";
  return links.map(l => `<a class="${cls}${l.muted ? " muted" : ""}" href="${l.url}" ` +
    `target="_blank" rel="noopener" ${l.title ? `title="${l.title.replace(/"/g, "&quot;")}"` : ""}>` +
    `${l.label} ↗</a>`).join("");
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
  // Bare number: the sidebar styles it as a count, the tab bar as a badge.
  $("favCount").textContent = state.favs.length ? String(state.favs.length) : "";
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
  if ($("fDaysOff").value !== "") p.set("max_days_off", $("fDaysOff").value);
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
  // Don't clobber a view the user picked while this was still loading.
  if (!state.userPicked) setMode(modeFromHash());
  checkChat();
  // Alert evaluation walks every pairing, so it must not block first paint.
  loadAlerts().then(() => { if (state.mode === "alerts") renderAlerts(); });
}

// The docs page links back as /#calendar etc., so honour the hash on arrival
// and when it changes.
const MODES = ["trips", "oneway", "calendar", "alerts", "favs"];
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
                   calendar: "Calendario", alerts: "Alertas", favs: "Favoritos" };
  // One-way lives inside the search page as a filter, so the same nav entry
  // stays lit for both of its modes.
  for (const [id, modes] of [["tabTrips", ["trips", "oneway"]],
                             ["tabCalendar", ["calendar"]],
                             ["tabAlerts", ["alerts"]],
                             ["tabFavs", ["favs"]]]) {
    $(id).classList.toggle("active", modes.includes(mode));
  }
  $("viewTitle").textContent = TITLES[mode] || "";
  const isTable = mode === "trips" || mode === "oneway";
  $("tableView").style.display = isTable ? "" : "none";
  $("lKind").style.display = isTable ? "" : "none";
  if (isTable) $("fKind").value = mode;
  $("lSort").style.display = isTable ? "" : "none";   // CSS keeps it phone-only
  $("calendarView").style.display = mode === "calendar" ? "" : "none";
  $("favsView").style.display = mode === "favs" ? "" : "none";
  $("alertsView").style.display = mode === "alerts" ? "" : "none";
  const chrome = mode === "favs" || mode === "alerts";
  $("toolbar").style.display = chrome ? "none" : "";
  document.querySelector(".tiles").style.display =
    (chrome || mode === "calendar") ? "none" : "";
  $("lNights").style.display = mode === "trips" ? "" : "none";
  $("lSame").style.display = mode === "trips" ? "" : "none";
  $("lGroup").style.display = mode === "trips" ? "" : "none";
  $("lSource").style.display = mode === "oneway" ? "" : "none";
  for (const id of ["fWhen", "fMax"]) {
    $(id).closest("label").style.display = mode === "calendar" ? "none" : "";
  }
  $("lDirect").style.display = mode === "calendar" ? "none" : "";
  $("lDaysOff").style.display = mode === "trips" ? "" : "none";
  $("calDirWrap").style.display = mode === "calendar" ? "" : "none";
  $("detail").classList.remove("open");

  if (mode === "favs") { await loadFavs(); renderFavs(); return; }
  if (mode === "alerts") { await loadAlerts(); renderAlerts(); return; }
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
  state.calOut = Object.fromEntries(data.outbound.map(d => [d.day, d]));
  state.calIn = Object.fromEntries(data.inbound.map(d => [d.day, d]));
  if (!state.calMonth) {
    const now = new Date();
    state.calMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
}

// Sequential blue ramp (light->dark = cheap->expensive is inverted here:
// cheap should stand out, so cheap = strong accent, expensive = faint).
const CAL_RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];

function renderCalendar() {
  const info = state.calDir === "outbound" ? state.calOut : state.calIn;
  // Colour by effective cost, like every other view: a 22 € fare from an
  // airport two hours away must not paint a greener day than a 107 € one from
  // the airport down the road.
  const days = {}, titles = {};
  for (const [iso, d] of Object.entries(info)) {
    days[iso] = d.effective;
    titles[iso] = `${iso} · ${d.airport}${d.airline ? " " + d.airline : ""} · ` +
      `${fmtEUR(d.price)} billete → ${fmtEUR(d.effective)} efectivo`;
  }
  const prices = Object.values(days);
  $("calTitle").textContent = state.calDir === "outbound"
    ? "Coste efectivo más bajo por día — ida hacia Alicante"
    : "Coste efectivo más bajo por día — vuelta desde Alicante";

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
    host.appendChild(monthGrid(base, days, colorFor, selectCalDay, titles));
  }
}

function monthGrid(base, days, colorFor, onClick, titles = {}) {
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
        title="${titles[iso] || `${iso} · ${fmtEUR(price)}`}">
        <span class="n">${d}</span><span class="p">${Math.round(price)}€</span></div>`;
    }
  }
  el.innerHTML = `<h3>${label}</h3>
    <div class="dow"><div>lu</div><div>ma</div><div>mi</div><div>ju</div><div>vi</div><div>sá</div><div>do</div></div>
    <div class="days">${cells}</div>`;
  el.querySelectorAll(".day.has").forEach(d => {
    d.addEventListener("click", () => onClick(d.dataset.day));
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

/* A saved trip is worth what it costs door to door, so the card leads with the
   effective cost and explains where it came from. */
function favBreakdown(f) {
  if (f.price_now == null) return "sin precio en la última captura";
  const bits = [`${fmtEUR(f.price_now)} billete`];
  if (f.adjustment) bits.push(`${f.adjustment > 0 ? "+" : "−"}${Math.abs(f.adjustment).toFixed(0)} € ajuste`);
  if (f.ground) bits.push(`+${f.ground.toFixed(0)} € coche`);
  if (f.holiday) bits.push(`+${f.holiday.toFixed(0)} € ${f.holiday_label}`);
  return bits.join(" ");
}

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
    const isTrip = f.legs.length === 2;
    const bookItem = isTrip
      ? { package: !!f.package,
          out: { origin: f.legs[0].origin, destination: f.legs[0].destination,
                 departure: f.legs[0].departure, source: f.legs[0].source },
          ret: { origin: f.legs[1].origin, destination: f.legs[1].destination,
                 departure: f.legs[1].departure, source: f.legs[1].source } }
      : { origin: f.legs[0].origin, destination: f.legs[0].destination,
          departure: f.legs[0].departure, source: f.legs[0].source };
    const bookHtml = bookingLinksHtml(bookingLinksFor(bookItem, isTrip), "small");

    el.innerHTML = `
      <button class="rm" title="Quitar">✕</button>
      <h3>${f.legs[0].origin} → ${f.legs[0].destination}${
        f.legs.length === 2 ? ` → ${f.legs[1].destination}` : ""}</h3>
      <div class="sub">${nights != null ? `${nights} noches · ` : ""}guardado ${
        f.created_at.slice(0, 10)}</div>
      ${legs}
      <div class="total"><span style="color:var(--ink-2);font-size:12.5px">coste efectivo</span>
        <span><span class="v">${f.effective_now != null ? fmtEUR(f.effective_now) : "—"}</span> ${delta}</span></div>
      <div style="color:var(--muted);font-size:11.5px;margin-top:-4px">${favBreakdown(f)}</div>
      <div class="book-links">${bookHtml}</div>`;
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
    { k: "days_off", t: "Días libres", num: true },
    { k: "price", t: "Precio", num: true },
    { k: "adjustment", t: "Ajuste", num: true },
    { k: "ground", t: "Coche", num: true },
    { k: "effective", t: "Efectivo", num: true },
    { k: "when", t: "Cuándo" },
  ],
  oneway: [
    { k: "_star", t: "", star: true },
    { k: "route", t: "Vuelo" }, { k: "departure", t: "Salida" },
    { k: "price", t: "Precio", num: true },
    { k: "adjustment", t: "Ajuste", num: true },
    { k: "ground", t: "Coche", num: true },
    { k: "effective", t: "Efectivo", num: true },
    { k: "label", t: "Cuándo" }, { k: "source", t: "Fuente" },
  ],
};

/* On a phone the table renders as cards without a header row, so the sort
   controls that live in the <th>s move into the filter bar instead. */
function renderSortControl() {
  const sel = $("fSort");
  sel.innerHTML = "";
  for (const c of COLS[state.mode]) {
    if (c.star) continue;
    const o = document.createElement("option");
    o.value = c.k; o.textContent = c.t;
    o.selected = c.k === state.sortKey;
    sel.appendChild(o);
  }
  $("fSortDir").textContent = state.sortDir === 1 ? "▲" : "▼";
  $("fSortDir").title = state.sortDir === 1 ? "Ascendente" : "Descendente";
}

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
  renderSortControl();
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
    // The cheapest ticket is nearly always not the best trip. Showing what it
    // really costs is the whole point of the tile sitting next to "mejor".
    $("tileCheapest").textContent = fmtEUR0(cheap.price);
    $("tileCheapestDetail").textContent =
      `${cheap.out.origin}→ALC ${fmtDep(cheap.out.departure)} · ${cheap.nights} noches · ` +
      `${fmtEUR0(cheap.effective)} efectivo`;
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
    $("tileCheapestDetail").textContent =
      `${cheap.route} · ${fmtDep(cheap.departure)} · ${fmtEUR0(cheap.effective)} efectivo`;
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

/* Twenty rows of the same Luxair route on consecutive dates say one thing, not
   twenty. Grouping keeps the best of each (airport pair, departure week) and
   folds the rest away, so the list shows the choices rather than the noise. */
function groupKey(t) {
  const d = new Date(t.out.departure);
  // Monday of that week, so a Fri/Sat pair of the same weekend stays together.
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${t.out.origin}|${t.ret.destination}|${monday.toISOString().slice(0, 10)}`;
}

function groupRows(sorted) {
  const seen = new Map();
  for (const t of sorted) {
    const k = groupKey(t);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(t);
  }
  const out = [];
  for (const [k, members] of seen) {
    const best = members[0];          // already in sort order
    best._group = k;
    best._more = members.length - 1;
    out.push(best);
    if (state.openGroups.has(k)) {
      for (const m of members.slice(1)) {
        m._group = k; m._more = 0; m._child = true;
        out.push(m);
      }
    }
  }
  // Folding reorders nothing on its own, but an opened group must not push its
  // parent out of position, so re-apply the active sort to the visible rows.
  return out;
}

function render() {
  const all = state.mode === "trips" ? filteredTrips() : filteredOneway();
  all.sort((a, b) => {
    const av = sortVal(a, state.sortKey), bv = sortVal(b, state.sortKey);
    return (typeof av === "number" ? av - bv : String(av).localeCompare(String(bv))) * state.sortDir;
  });
  const grouped = state.mode === "trips" && state.group;
  const shown = grouped ? groupRows(all) : all;

  document.querySelectorAll("#tbl th").forEach(th => {
    const arrow = th.querySelector(".arrow");   // the star column has none
    if (arrow) {
      arrow.textContent =
        th.dataset.k === state.sortKey ? (state.sortDir === 1 ? "▲" : "▼") : "";
    }
  });
  renderSortControl();

  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * PAGE_SIZE;
  const rows = shown.slice(start, start + PAGE_SIZE);

  const tbody = $("tbody");
  tbody.innerHTML = "";
  if (!rows.length) {
    const cols = COLS[state.mode].length;
    tbody.innerHTML = `<tr><td class="empty-row" colspan="${cols}">Ningún resultado con estos filtros.</td></tr>`;
  }
  for (const item of rows) {
    const tr = document.createElement("tr");
    if (state.selected === item) tr.classList.add("selected");
    if (grouped && item._child) tr.classList.add("child");
    tr.innerHTML = state.mode === "trips"
      ? tripRow(item, grouped) : onewayRow(item);
    tr.addEventListener("click", ev => {
      if (ev.target.closest(".star")) {
        ev.stopPropagation();
        toggleFav(state.mode === "trips" ? tripFav(item) : flightFav(item));
        return;
      }
      if (ev.target.closest(".more")) {
        ev.stopPropagation();
        if (state.openGroups.has(item._group)) state.openGroups.delete(item._group);
        else state.openGroups.add(item._group);
        render();
        return;
      }
      state.mode === "trips" ? selectTrip(item) : selectFlight(item);
    });
    tbody.appendChild(tr);
  }

  const noun = state.mode === "trips" ? "viajes" : "vuelos";
  $("rowCount").textContent = grouped && shown.length < all.length
    ? `${shown.length.toLocaleString("es-ES")} de ${all.length.toLocaleString("es-ES")} ${noun}`
    : `${all.length.toLocaleString("es-ES")} ${noun}`;
  renderPager(shown.length, pages);
}

// 0 days off is the thing worth spotting, so it reads as a win, not a zero.
// The euros those days cost ride in the tooltip rather than in a column of
// their own: the table is wide enough, and the detail panel spells it out.
function daysOffCell(d, holiday) {
  if (d === undefined || d === null) return "–";
  const tip = holiday ? ` title="${holiday.toFixed(0)} € de vacaciones"` : "";
  if (d === 0) return `<span class="badge good">ninguno</span>`;
  return `<span class="badge ${d <= 1 ? "" : "warn"}"${tip}>${d}</span>`;
}

// What the airport costs you before the airline charges anything: the drive
// there and back, plus parking while the car waits.
function groundCell(g) {
  if (!g) return "–";
  return `+${g.toFixed(0)} €`;
}

// Ticket, convenience and car, spelled out — so the ranking never looks arbitrary.
function costBreakdown(item) {
  const bits = [`${fmtEUR(item.price)} billete`];
  if (item.adjustment) bits.push(`${item.adjustment > 0 ? "+" : "−"}${Math.abs(item.adjustment).toFixed(0)} € ajuste`);
  if (item.ground) bits.push(`+${item.ground.toFixed(0)} € coche${item.ground_label ? ` (${item.ground_label})` : ""}`);
  if (item.holiday) bits.push(`+${item.holiday.toFixed(0)} € ${item.holiday_label}`);
  return `${bits.join(" ")} = ${fmtEUR(item.effective)} efectivo`;
}

/* Every cell carries its column name so the narrow-screen card layout, which
   drops the header row, can print the label next to the value. */
function tripRow(t, grouped) {
  const more = grouped && t._more
    ? ` <span class="more" title="Otras ${t._more} combinaciones parecidas esa semana">${
        state.openGroups.has(t._group) ? "−" : "+"}${t._more}</span>`
    : "";
  return starCell(tripFav(t)) + `
    <td data-t="Ida">${legCell(t.out.origin, "ALC", t.out.airline, t.out.stops)}${more}</td>
    <td data-t="Salida">${whenCell(t.out.departure, t.out.date_only)}</td>
    <td data-t="Vuelta">${legCell("ALC", t.ret.destination, t.ret.airline, t.ret.stops)}</td>
    <td data-t="Regreso">${whenCell(t.ret.departure, t.ret.date_only)}</td>
    <td class="num" data-t="Noches">${t.nights}</td>
    <td class="num" data-t="Días libres">${daysOffCell(t.days_off, t.holiday)}</td>
    <td class="num" data-t="Precio">${fmtEUR(t.price)}${t.package ? ' <span class="badge">paq.</span>' : ""}</td>
    <td class="num adj" data-t="Ajuste">${t.adjustment > 0 ? "+" : ""}${t.adjustment.toFixed(0)} €</td>
    <td class="num adj" data-t="Coche" title="${t.ground_label || ""}">${groundCell(t.ground)}</td>
    <td class="num" data-t="Efectivo"><span class="eff">${fmtEUR(t.effective)}</span></td>
    <td data-t="Cuándo">${badges(t.out.label)}</td>`;
}

function onewayRow(f) {
  return starCell(flightFav(f)) + `
    <td data-t="Vuelo">${legCell(f.origin, f.destination, f.airline, f.stops)}</td>
    <td data-t="Salida">${whenCell(f.departure)}</td>
    <td class="num" data-t="Precio">${fmtEUR(f.price)}</td>
    <td class="num adj" data-t="Ajuste">${f.adjustment > 0 ? "+" : ""}${f.adjustment.toFixed(0)} €</td>
    <td class="num adj" data-t="Coche" title="${f.ground_label || ""}">${groundCell(f.ground)}</td>
    <td class="num" data-t="Efectivo"><span class="eff">${fmtEUR(f.effective)}</span></td>
    <td data-t="Cuándo">${badges(f.label)}</td>
    <td data-t="Fuente"><span class="src">${f.source}</span></td>`;
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
    `${f.airline || "?"} · ${stopsES(f.stops)} · ${costBreakdown(f)}`, false);
  $("dBook").innerHTML = bookingLinksHtml(bookingLinksFor(f, false));
  drawChart([{ pts: await fetchHistory(f.origin, f.destination, f.departure),
               color: "--series-1", name: "precio" }]);
}

async function selectTrip(t) {
  state.selected = t;
  render();
  openDetail(
    `${t.out.origin} → ALC → ${t.ret.destination} · ${t.nights} noches`,
    `Ida ${fmtDep(t.out.departure)} (${t.out.airline || "?"}) · vuelta ${fmtDep(t.ret.departure)} ` +
    `(${t.ret.airline || "?"}) · ${costBreakdown(t)}`, true);
  $("dBook").innerHTML = bookingLinksHtml(bookingLinksFor(t, true));
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
  state.chartSeries = seriesList;
  const host = $("chartHost");
  seriesList = seriesList.filter(s => s.pts.length);
  if (!seriesList.length) {
    host.innerHTML = `<div class="empty">Sin histórico todavía. Cada <code>fetch</code> añade un punto.</div>`;
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const C = n => css.getPropertyValue(n).trim();
  const W = host.clientWidth || 900;
  const narrow = W < 460;                       // phone: shorter, tighter gutters
  const H = narrow ? 170 : 220;
  const m = narrow ? { top: 12, right: 10, bottom: 24, left: 42 }
                   : { top: 14, right: 16, bottom: 26, left: 54 };
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
    // A flat series needs decimals or every gridline reads the same number.
    const lbl = (p1 - p0) < 8 ? v.toFixed(1) : String(Math.round(v));
    yLabels += `<text x="${m.left - 7}" y="${y + 4}" text-anchor="end" font-size="${narrow ? 10 : 11}" fill="${C("--muted")}">${lbl} €</text>`;
  }
  const fmtT = t => { const d = new Date(t); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  let xLabels = "";
  const shown = new Set();
  let lastX = -Infinity;
  const minGap = narrow ? 54 : 42;              // px between date labels
  for (const t of [...new Set(ts)].sort((a, b) => a - b)) {
    const lbl = fmtT(t);
    if (shown.has(lbl)) continue;
    const x = X(t);
    if (x - lastX < minGap) continue;
    shown.add(lbl); lastX = x;
    // Keep the first and last labels inside the frame instead of half cut off.
    const half = lbl.length * (narrow ? 2.6 : 2.9);
    const lx = Math.max(half + 2, Math.min(x, W - half - 2));
    xLabels += `<text x="${lx}" y="${H - 8}" text-anchor="middle" font-size="${narrow ? 10 : 11}" fill="${C("--muted")}">${lbl}</text>`;
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
  const probe = ev => {
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
    // Keep the tooltip on screen, and above the finger rather than under it.
    const tw = tip.offsetWidth || 150, th = tip.offsetHeight || 46;
    tip.style.left = Math.max(8, Math.min(ev.clientX + 14, window.innerWidth - tw - 8)) + "px";
    tip.style.top = (ev.pointerType === "touch"
      ? Math.max(8, ev.clientY - th - 16) : ev.clientY + 14) + "px";
  };
  const hide = () => { xhair.style.display = "none"; tip.style.display = "none"; };
  // Pointer events cover mouse and touch; pan-y keeps the page scrollable while
  // a horizontal drag reads the series.
  svg.addEventListener("pointerdown", probe);
  svg.addEventListener("pointermove", ev => { if (ev.pointerType !== "touch" || ev.buttons || ev.pressure) probe(ev); });
  svg.addEventListener("pointerup", hide);
  svg.addEventListener("pointercancel", hide);
  svg.addEventListener("pointerleave", hide);
}

// The chart is sized in absolute pixels, so it has to be redrawn when the
// viewport changes (rotation, keyboard, chat panel opening).
let chartResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (state.chartSeries && $("detail").classList.contains("open")) {
      drawChart(state.chartSeries);
    }
    if (state.mode === "calendar") renderCalendar();
  }, 150);
});

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
  const bookItem = round
    ? { package: pkg,
        out: { origin: fav.out_origin, destination: fav.out_destination, departure: fav.out_departure },
        ret: { origin: fav.ret_origin, destination: fav.ret_destination, departure: fav.ret_departure } }
    : { origin: fav.out_origin, destination: fav.out_destination, departure: fav.out_departure };
  // The model doesn't know which provider quoted it, so trip/flight markers
  // fall back to a Google Flights search — bookingLinkForLeg does this for
  // any source it doesn't recognise. Luxair packages still get their own link.
  const bookHtml = bookingLinksHtml(bookingLinksFor(bookItem, round), "small");

  el.innerHTML = `<div class="r">${title}</div><div class="d">${when}</div>
    <div class="act">
      <button class="${on ? "on" : ""}">${on ? "★ Guardado" : "☆ Guardar"}</button>
      ${bookHtml}
    </div>`;
  el.querySelector(".act button").addEventListener("click", () => toggleFav(fav));
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
  // Full-screen on a phone: stop the page behind it from scrolling too.
  document.body.classList.toggle("chat-open", open);
  $("chatToggle").classList.toggle("on", open);
  if (open) setTimeout(() => $("chatInput").focus(), 180);
}

// ---------- events ----------

const pick = mode => { state.userPicked = true; setMode(mode); };
// The nav entry always lands on round trips; the Tipo field switches within.
$("tabTrips").addEventListener("click", () => pick("trips"));
$("fKind").addEventListener("input", () => pick($("fKind").value));
$("tabCalendar").addEventListener("click", () => pick("calendar"));
$("tabFavs").addEventListener("click", () => pick("favs"));
$("tabAlerts").addEventListener("click", () => pick("alerts"));
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

$("fSort").addEventListener("change", e => {
  state.sortKey = e.target.value; state.page = 1; render();
});
$("fSortDir").addEventListener("click", () => {
  state.sortDir *= -1; state.page = 1; render();
});

let filterTimer = null;
function onFilterChange() {
  state.page = 1;
  if (state.mode === "calendar") {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(async () => { await loadCalendar(); renderCalendar(); }, 200);
    return;
  }
  if (state.mode === "favs" || state.mode === "alerts") return;
  if (state.mode !== "trips") { render(); return; }
  clearTimeout(filterTimer);
  filterTimer = setTimeout(async () => {
    await loadTrips();
    renderTiles();
    render();
  }, 200);
}
for (const id of ["fAirport", "fWhen", "fSource", "fMax", "fSame", "fDirect",
                  "fMinN", "fMaxN", "fDaysOff"]) {
  $(id).addEventListener("input", onFilterChange);
}
// Grouping is a view of the rows already loaded, so it never refetches.
$("fGroup").addEventListener("input", () => {
  state.group = $("fGroup").checked;
  state.openGroups.clear();
  state.page = 1;
  render();
});



// ---------- alerts ----------

async function loadAlerts() {
  const data = await (await fetch("/api/alerts")).json();
  state.alerts = data.alerts;
  const n = data.unseen;
  $("alertCount").textContent = n ? String(n) : "";
  $("alertCount").style.color = n ? "var(--accent)" : "";
}

function alertRules(a) {
  const bits = [];
  bits.push(a.airport ? `desde ${a.airport}` : "cualquier aeropuerto");
  if (a.max_price != null) bits.push(`≤ ${Math.round(a.max_price)} €`);
  bits.push(a.max_days_off == null ? "días libres: los que sean"
    : a.max_days_off === 0 ? "sin días libres" : `≤ ${a.max_days_off} día(s) libre(s)`);
  bits.push(`${a.min_nights}–${a.max_nights} noches`);
  if (a.direct_only) bits.push("solo directos");
  return bits.join(" · ");
}

const alertDay = iso => {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const alertTime = leg => {
  if (leg.date_only) return "";
  const d = new Date(leg.departure);
  return ` ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function alertRow(m) {
  const off = m.days_off === 0
    ? `<span class="tag free">sin días libres</span>`
    : `<span class="tag">${m.days_off} día${m.days_off === 1 ? "" : "s"} libre${m.days_off === 1 ? "" : "s"}</span>`;
  const el = document.createElement("div");
  el.className = "alert-row" + (m.is_new ? " is-new" : "");
  el.innerHTML =
    (m.is_new ? `<span class="newdot" title="Nuevo"></span>` : `<span style="width:6px"></span>`) +
    `<span class="route">${m.out.origin} → ALC → ${m.ret.destination}</span>` +
    `<span class="dates">${alertDay(m.out.departure)}${alertTime(m.out)} → ` +
    `${alertDay(m.ret.departure)}${alertTime(m.ret)} · ${m.nights}n · ` +
    `${m.out.airline}${m.package ? " (paq.)" : ""}</span>` +
    off +
    `<span class="price" title="${costBreakdown(m)}">${fmtEUR(m.effective)}` +
    `<span style="display:block;color:var(--muted);font-size:11px;font-weight:500">` +
    `${fmtEUR(m.price)} billete</span></span>` +
    bookingLinksHtml(bookingLinksFor(m, true), "small");
  el.querySelectorAll(".book-link").forEach(a => a.addEventListener("click", e => e.stopPropagation()));
  el.addEventListener("click", () => {
    // Jump to the trip list narrowed around this match.
    $("fAirport").value = m.out.origin === "ALC" ? "" : m.out.origin;
    $("fMinN").value = m.nights;
    $("fMaxN").value = m.nights;
    $("fDaysOff").value = "";
    $("fWhen").value = "";
    $("fMax").value = "";
    setMode("trips");
  });
  return el;
}

// Chronological month buckets, most recent first-seen date within each month
// kept in date order (the backend already sorts matches by price, which is
// not the order you want once you're scanning a whole month at a glance).
function groupMatchesByMonth(matches) {
  const groups = new Map();
  for (const m of matches) {
    const d = new Date(m.out.departure);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, list] of ordered) {
    list.sort((a, b) => new Date(a.out.departure) - new Date(b.out.departure));
  }
  return ordered;
}

function renderAlertList(rows, matches) {
  for (const [key, list] of groupMatchesByMonth(matches)) {
    const [y, mo] = key.split("-").map(Number);
    const label = new Date(y, mo - 1, 1).toLocaleDateString("es-ES", { month: "long", year: "numeric" });
    const head = document.createElement("div");
    head.className = "alert-month";
    head.innerHTML = `${label} <span class="n">· ${list.length}</span>`;
    rows.appendChild(head);
    for (const m of list) rows.appendChild(alertRow(m));
  }
}

// Sequential ramp reused from the main calendar, cheap = strong colour.
function renderAlertCalendar(rows, alert, matches) {
  const byDay = {};       // ISO day -> best effective cost seen that day
  const titles = {};
  const newByDay = {};    // ISO day -> any match that day is new
  for (const m of matches) {
    const day = m.out.departure.slice(0, 10);
    if (!(day in byDay) || m.effective < byDay[day]) {
      byDay[day] = m.effective;
      titles[day] = `${day} · ${m.out.origin} → ALC → ${m.ret.destination} · ` +
        `${fmtEUR(m.price)} billete → ${fmtEUR(m.effective)} efectivo`;
    }
    if (m.is_new) newByDay[day] = true;
  }
  const days = Object.keys(byDay).sort();
  if (!days.length) {
    rows.innerHTML = `<div class="alert-empty">Nada por ahora.</div>`;
    return;
  }
  const prices = Object.values(byDay);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const colorFor = p => {
    if (hi === lo) return CAL_RAMP[0];
    const t = (Math.log(p) - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
    return CAL_RAMP[Math.min(CAL_RAMP.length - 1, Math.floor(t * CAL_RAMP.length))];
  };

  const host = document.createElement("div");
  host.className = "alert-cal";
  const first = new Date(days[0] + "T00:00:00");
  const last = new Date(days[days.length - 1] + "T00:00:00");
  let cursor = new Date(first.getFullYear(), first.getMonth(), 1);
  const stop = new Date(last.getFullYear(), last.getMonth(), 1);
  while (cursor <= stop) {
    const grid = monthGrid(cursor, byDay, colorFor,
                           iso => selectAlertCalDay(alert, iso), titles);
    if (newByDay) {
      grid.querySelectorAll(".day.has").forEach(d => {
        if (newByDay[d.dataset.day]) d.style.outline = "2px solid var(--accent)";
      });
    }
    host.appendChild(grid);
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }
  rows.appendChild(host);
}

async function selectAlertCalDay(a, iso) {
  // Jump into the main trips view, pre-filtered to this alert's rules and
  // narrowed to the day you clicked — the alert card only shows the best few
  // matches, this shows every trip that day.
  $("fAirport").value = a.airport || "";
  $("fMinN").value = a.min_nights;
  $("fMaxN").value = a.max_nights;
  $("fDaysOff").value = a.max_days_off ?? "";
  $("fMax").value = a.max_price ?? "";
  $("fWhen").value = "";
  $("fDirect").checked = !!a.direct_only;
  state.userPicked = true;
  await setMode("trips");
  state.trips = state.trips.filter(t => t.out.departure.startsWith(iso));
  $("rowCount").textContent = `${state.trips.length} viajes saliendo el ${iso}`;
  render();
}

function renderAlerts() {
  const host = $("alertList");
  host.innerHTML = "";
  if (!state.alerts.length) {
    host.innerHTML = `<div class="alert-empty">No hay alertas todavía.</div>`;
    return;
  }
  for (const entry of state.alerts) {
    const a = entry.alert;
    const el = document.createElement("div");
    el.className = "alert" + (a.enabled ? "" : " off");
    const nNew = entry.matches.filter(m => m.is_new).length;
    el.innerHTML = `
      <div class="alert-head">
        <div>
          <h3>${a.name}</h3>
          <div class="rules">${alertRules(a)}</div>
        </div>
        <div class="grow"></div>
        ${nNew ? `<span class="pill new">${nNew} nueva${nNew === 1 ? "" : "s"}</span>` : ""}
        <span class="pill ${entry.total ? "hit" : ""}">${entry.total} coincidencia${entry.total === 1 ? "" : "s"}</span>
        <div class="view-toggle" data-role="viewtoggle">
          <button data-view="list"><span>☰</span><span>Lista</span></button>
          <button data-view="calendar"><span>▦</span><span>Calendario</span></button>
        </div>
        <button data-act="toggle" title="${a.enabled ? "Desactivar" : "Activar"}">${a.enabled ? "◉" : "○"}</button>
        <button data-act="edit" title="Editar">✎</button>
        <button data-act="del" title="Borrar">✕</button>
      </div>
      <div class="alert-rows"></div>`;

    const view = state.alertView[a.id] || "list";
    el.querySelectorAll('[data-role="viewtoggle"] button').forEach(b => {
      b.classList.toggle("active", b.dataset.view === view);
      b.addEventListener("click", () => {
        state.alertView[a.id] = b.dataset.view;
        renderAlerts();
      });
    });

    const rows = el.querySelector(".alert-rows");
    if (!a.enabled) {
      rows.innerHTML = `<div class="alert-empty">Desactivada.</div>`;
    } else if (!entry.matches.length) {
      rows.innerHTML = `<div class="alert-empty">Nada por ahora. Se revisa en cada <code>fetch</code>.</div>`;
    } else if (view === "calendar") {
      renderAlertCalendar(rows, a, entry.matches);
    } else {
      renderAlertList(rows, entry.matches);
    }

    el.querySelector('[data-act="toggle"]').addEventListener("click", async () => {
      await fetch(`/api/alerts/${a.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...a, enabled: !a.enabled }),
      });
      await loadAlerts();
      renderAlerts();
    });
    el.querySelector('[data-act="edit"]').addEventListener("click", () => {
      state.alertEditing = state.alertEditing === a.id ? null : a.id;
      renderAlerts();
    });
    el.querySelector('[data-act="del"]').addEventListener("click", async () => {
      await fetch(`/api/alerts/${a.id}`, { method: "DELETE" });
      await loadAlerts();
      renderAlerts();
    });

    if (state.alertEditing === a.id) el.insertBefore(alertForm(a), el.children[1]);
    host.appendChild(el);
  }

  if (state.alertEditing === "new") host.prepend(wrapForm(alertForm(null)));

  // Opening this view is what marks the new matches as read.
  if (state.alerts.some(e => e.unseen)) {
    fetch("/api/alerts/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).then(() => { $("alertCount").textContent = ""; });
  }
}

function wrapForm(form) {
  const el = document.createElement("div");
  el.className = "alert";
  el.appendChild(form);
  return el;
}

function alertForm(a) {
  const f = document.createElement("div");
  f.className = "alert-form";
  const v = (x, d) => (x === null || x === undefined ? d : x);
  const esc = t => String(t).replace(/"/g, "&quot;");
  f.innerHTML = `
    <label class="field"><span>Nombre</span>
      <input type="text" data-f="name" value="${a ? esc(a.name) : ""}" placeholder="Finde barato"></label>
    <label class="field"><span>Aeropuerto</span>
      <select data-f="airport">
        <option value="">Cualquiera</option>
        ${["LUX", "SCN", "HHN"].map(x =>
          `<option value="${x}" ${a && a.airport === x ? "selected" : ""}>${x}</option>`).join("")}
      </select></label>
    <label class="field"><span>Precio máx (€)</span>
      <input type="number" class="narrow" data-f="max_price" min="0" step="10"
             value="${a && a.max_price != null ? Math.round(a.max_price) : ""}"></label>
    <label class="field"><span>Días libres máx</span>
      <select data-f="max_days_off">
        <option value="">Los que sean</option>
        ${[0, 1, 2, 3].map(n =>
          `<option value="${n}" ${a && a.max_days_off === n ? "selected" : ""}>${n === 0 ? "Ninguno" : n}</option>`).join("")}
      </select></label>
    <label class="field"><span>Noches</span>
      <span class="nights">
        <input type="number" class="narrow" data-f="min_nights" min="0" value="${v(a && a.min_nights, 1)}">
        <span>–</span>
        <input type="number" class="narrow" data-f="max_nights" min="0" value="${v(a && a.max_nights, 4)}">
      </span></label>
    <label class="toggle"><input type="checkbox" data-f="direct_only" ${a && a.direct_only ? "checked" : ""}> solo directos</label>
    <div class="actions">
      <button data-act="cancel">Cancelar</button>
      <button class="save" data-act="save">Guardar</button>
    </div>`;

  f.querySelector('[data-act="cancel"]').addEventListener("click", () => {
    state.alertEditing = null;
    renderAlerts();
  });
  f.querySelector('[data-act="save"]').addEventListener("click", async () => {
    const body = {};
    for (const el of f.querySelectorAll("[data-f]")) {
      body[el.dataset.f] = el.type === "checkbox" ? el.checked : el.value;
    }
    await fetch(a ? `/api/alerts/${a.id}` : "/api/alerts", {
      method: a ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a ? { ...body, enabled: !!a.enabled } : body),
    });
    state.alertEditing = null;
    await loadAlerts();
    renderAlerts();
  });
  return f;
}

$("alertNew").addEventListener("click", () => {
  state.alertEditing = state.alertEditing === "new" ? null : "new";
  renderAlerts();
});

// Redraw anything painted with resolved colours when the theme changes.
window.onThemeChange = () => {
  if (state.selected && $("detail").classList.contains("open")) {
    state.mode === "trips" ? selectTrip(state.selected) : selectFlight(state.selected);
  }
  if (state.mode === "calendar") renderCalendar();
};

load();
