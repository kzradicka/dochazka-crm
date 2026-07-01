import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import { api } from '../api.js';
import { fmtDateTime } from '../format.js';

export default function History() {
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [sites, setSites] = useState([]);
  const [filters, setFilters] = useState({ from: '', to: '', employee_id: '', site_id: '' });
  const [loading, setLoading] = useState(false);

  // Inline úprava záznamu
  const [editId, setEditId] = useState(null);
  const [editVals, setEditVals] = useState({ hours: 12, site_id: '' });

  useEffect(() => {
    api.employees().then(setEmployees).catch(() => {});
    api.sites().then(setSites).catch(() => {});
    load();
  }, []);

  async function load() {
    setLoading(true);
    const q = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    try { setRows(await api.attendance(q)); } catch {} finally { setLoading(false); }
  }

  function startEdit(r) {
    setEditId(r.id);
    setEditVals({ hours: r.hours, site_id: r.site_id || '' });
  }
  function cancelEdit() { setEditId(null); }
  async function saveEdit(id) {
    await api.updateAttendance(id, {
      hours: Number(editVals.hours),
      site_id: editVals.site_id || null,
    });
    setEditId(null);
    load();
  }
  async function remove(id) {
    if (!window.confirm('Opravdu smazat tento záznam?')) return;
    await api.deleteAttendance(id);
    load();
  }

  function exportXlsx() {
    const data = rows.map((r) => ({
      'Datum a čas': fmtDateTime(r.called_at),
      'Zaměstnanec': r.employee,
      'Osobní číslo': r.pin_code,
      'Hodiny': r.hours,
      'Objekt': r.site || '',
      'Telefon volajícího': r.caller_number || '',
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Docházka');
    XLSX.writeFile(wb, `dochazka_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // Přehled „Podklad mezd" – matice den×zaměstnanec se značkami D/N, součty a prázdné sloupce k doplnění.
  function exportPrehled() {
    // Pražský čas z ISO data: vrátí { day: 1..31, hour: 0..23, ym: 'YYYY-MM' }.
    const pragueParts = (iso) => {
      const p = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Prague', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
      }).formatToParts(new Date(iso));
      const g = (t) => p.find((x) => x.type === t)?.value;
      let h = parseInt(g('hour'), 10);
      if (h === 24) h = 0;
      return { day: parseInt(g('day'), 10), hour: h, ym: `${g('year')}-${g('month')}` };
    };

    // Klasifikace směny podle hodiny příchodu: D = 4:00–15:00, N = 15:00–4:00.
    const shiftType = (hour) => (hour >= 4 && hour < 15 ? 'D' : 'N');

    // Seskupení: zaměstnanec → den → { hasD, hasN, hours }.
    // Jeden den = jedna směna daného typu (víc nahlášení téhož typu se nezdvojuje).
    const emps = new Map(); // pin_code → { name, days: Map(day → {hasD,hasN,hours}) }
    for (const r of rows) {
      const t = pragueParts(r.called_at);
      const type = shiftType(t.hour);
      if (!emps.has(r.pin_code)) emps.set(r.pin_code, { name: r.employee, days: new Map() });
      const emp = emps.get(r.pin_code);
      if (!emp.days.has(t.day)) emp.days.set(t.day, { hasD: false, hasN: false, hoursD: 0, hoursN: 0 });
      const d = emp.days.get(t.day);
      const hrs = Number(r.hours) || 0;
      // Hodiny bereme jen za první nahlášení daného typu v daném dni (další duplicitní ignorujeme).
      if (type === 'D') { if (!d.hasD) d.hoursD = hrs; d.hasD = true; }
      else { if (!d.hasN) d.hoursN = hrs; d.hasN = true; }
    }

    // Sestavení matice (Array of Arrays), aby šlo psát vzorce a prázdné buňky přesně.
    const header = ['Pracovník'];
    for (let i = 1; i <= 31; i++) header.push(String(i));
    header.push('Den', 'Noc', 'D/N', 'celkem hodin', 'přesčas', 'so,ne', 'svátek', 'noční', 'poznámka');

    const title = 'Podklad pro výpočet výplat – docházka';
    const legend = 'D = denní/ranní směna, N = noční/večerní směna, D/N = více záznamů v jednom dni';

    const aoa = [[title], [legend], header];

    const sorted = [...emps.values()].sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    let rowIdx = 4; // první datový řádek v Excelu (1=title, 2=legend, 3=header)
    for (const emp of sorted) {
      const line = new Array(41).fill('');
      line[0] = emp.name;
      let hours = 0;
      for (let day = 1; day <= 31; day++) {
        const d = emp.days.get(day);
        if (!d) continue;
        let mark = '';
        if (d.hasD && d.hasN) { mark = 'D/N'; hours += d.hoursD + d.hoursN; }
        else if (d.hasD) { mark = 'D'; hours += d.hoursD; }
        else if (d.hasN) { mark = 'N'; hours += d.hoursN; }
        line[day] = mark; // sloupce B..AF = index 1..31
      }
      // AG(32)=Den, AH(33)=Noc, AI(34)=D/N vzorce jako ve vzoru; AJ(35)=celkem hodin (číslo).
      line[32] = { f: `COUNTIF(B${rowIdx}:AF${rowIdx},"D")+COUNTIF(B${rowIdx}:AF${rowIdx},"D/N")` };
      line[33] = { f: `COUNTIF(B${rowIdx}:AF${rowIdx},"N")+COUNTIF(B${rowIdx}:AF${rowIdx},"D/N")` };
      line[34] = { f: `COUNTIF(B${rowIdx}:AF${rowIdx},"D/N")` };
      line[35] = hours;
      // AK(36)..AO(40) zůstávají prázdné pro ruční doplnění.
      aoa.push(line);
      rowIdx++;
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Šířka prvního sloupce (jména).
    ws['!cols'] = [{ wch: 22 }, ...Array(31).fill({ wch: 3.5 }),
      { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 11 },
      { wch: 8 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 14 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Podklad mezd');
    const range = [filters.from, filters.to].filter(Boolean).join('_');
    XLSX.writeFile(wb, `podklad_mezd_${range || new Date().toISOString().slice(0, 10)}.xlsx`);
  }
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  return (
    <div>
      <h2>Historie docházky</h2>
      <div className="card">
        <div className="filters">
          <div className="f"><label>Od</label><input type="date" value={filters.from} onChange={set('from')} /></div>
          <div className="f"><label>Do</label><input type="date" value={filters.to} onChange={set('to')} /></div>
          <div className="f">
            <label>Zaměstnanec</label>
            <select value={filters.employee_id} onChange={set('employee_id')}>
              <option value="">Všichni</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="f">
            <label>Objekt</label>
            <select value={filters.site_id} onChange={set('site_id')}>
              <option value="">Všechny</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <button className="btn-primary" onClick={load}>Filtrovat</button>
          <button className="btn-ghost" onClick={exportXlsx} disabled={!rows.length}>Export do Excelu</button>
          <button className="btn-ghost" onClick={exportPrehled} disabled={!rows.length}>Export přehledu</button>
        </div>

        {loading ? (
          <div className="empty">Načítám…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Žádné záznamy pro zvolený filtr.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Datum a čas</th><th>Zaměstnanec</th><th>Os. číslo</th>
                <th>Hodiny</th><th>Objekt</th><th>Telefon</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                editId === r.id ? (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.called_at)}</td>
                    <td>{r.employee}</td>
                    <td>{r.pin_code}</td>
                    <td>
                      <input type="number" min="0" step="0.5" style={{ width: 70 }}
                        value={editVals.hours}
                        onChange={(e) => setEditVals({ ...editVals, hours: e.target.value })} />
                    </td>
                    <td>
                      <select value={editVals.site_id}
                        onChange={(e) => setEditVals({ ...editVals, site_id: e.target.value })}>
                        <option value="">—</option>
                        {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                    <td>{r.caller_number || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-primary" onClick={() => saveEdit(r.id)}>Uložit</button>
                      <button className="btn-ghost" onClick={cancelEdit}>Zrušit</button>
                    </td>
                  </tr>
                ) : (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.called_at)}</td>
                    <td>{r.employee}</td>
                    <td>{r.pin_code}</td>
                    <td>{r.hours} h</td>
                    <td>{r.site || '—'}</td>
                    <td>{r.caller_number || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-ghost" onClick={() => startEdit(r)}>Upravit</button>
                      <button className="btn-ghost" onClick={() => remove(r.id)}>Smazat</button>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
