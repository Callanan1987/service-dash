// SimPro -> tracker. Netlify env vars:
//   SIMPRO_BUILD  firstairuk.simprosuite.com
//   SIMPRO_COMPANY 0
//   SIMPRO_TOKEN  elll7fa38d6cf6cf9a59222ddfc1f009447516d7
//   JOB_TYPE (default "Service")   APP_KEY (optional access key the tracker asks for once)
//   SIMPRO_WEBHOOK (optional, e.g. a Zapier catch hook that receives jobs completed in the tracker)
//   SIMPRO_CONTRACTS_PATH (optional, SimPro endpoint for renewals; fields mapped in mapContract below)
const E = process.env, B = `https://${E.SIMPRO_BUILD}.simprosuite.com`, C = E.SIMPRO_COMPANY || '0';
let tok, exp = 0;
async function token() {
  if (E.SIMPRO_TOKEN) return E.SIMPRO_TOKEN;
  if (tok && Date.now() < exp) return tok;
  const r = await fetch(B + '/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: E.SIMPRO_CLIENT_ID, client_secret: E.SIMPRO_CLIENT_SECRET }) });
  if (!r.ok) throw Error('SimPro auth failed ' + r.status);
  const j = await r.json(); tok = j.access_token; exp = Date.now() + (j.expires_in - 60) * 1e3; return tok;
}
async function get(path, q) {            // pages through a list endpoint (250 per page, build limit 10 calls/s)
  const h = { Authorization: 'Bearer ' + await token() }, out = [];
  for (let p = 1; ; p++) {
    const r = await fetch(`${B}/api/v1.0/companies/${C}/${path}/?${new URLSearchParams({ ...q, pageSize: 250, page: p })}`, { headers: h });
    if (!r.ok) { const e = Error(`SimPro ${r.status} on ${path}`); e.status = r.status; throw e; }
    const b = await r.json(); out.push(...b);
    if (b.length < 250 || p >= +(r.headers.get('Result-Pages') || 1)) return out;
    await new Promise(z => setTimeout(z, 120));
  }
}
const name = c => c ? (c.CompanyName || `${c.GivenName || ''} ${c.FamilyName || ''}`.trim()) : '';
const kind = s => /leak|f-?gas/i.test(s) ? 'F-Gas leak check' : /annual/i.test(s) ? 'Annual service' : /ppm|planned|maint|service/i.test(s) ? 'PPM visit' : 'Other';
const day = s => (s || '').slice(0, 10), ago = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
function mapJob(j) {                     // edit here if your job names/fields differ
  const done = /^(complete|invoiced)/i.test(j.Stage || '');
  return { sid: j.ID, ref: j.ID, c: name(j.Customer), s: j.Site?.Name || '-', u: j.Name || j.Description || '', t: kind(`${j.Name} ${j.Description}`),
    d: day(j.DueDate) || day(j.DateIssued), x: done ? (day(j.CompletedDate) || day(j.DateModified)) : '' };
}
const mapContract = k => ({ sid: k.ID, c: name(k.Customer), n: k.Name || 'Contract', d: day(k.EndDate), v: k.Value || 0 });   // check field names for your build
async function jobs() {
  const cols = 'ID,Type,Name,Description,Customer,Site,Stage,DateIssued,DueDate,DateModified';
  let raw; try { raw = await get('jobs', { columns: cols + ',CompletedDate' }); } catch (e) { if (e.status !== 400) throw e; raw = await get('jobs', { columns: cols }); }
  const type = (E.JOB_TYPE || 'Service').toLowerCase(), cut = ago(90);
  return raw.filter(j => (j.Type || '').toLowerCase() === type && !/archived/i.test(j.Stage || '')).map(mapJob).filter(j => j.d && (!j.x || j.x >= cut));
}
exports.handler = async e => {
  const H = { 'content-type': 'application/json' };
  if (E.APP_KEY && e.headers['x-app-key'] !== E.APP_KEY) return { statusCode: 401, headers: H, body: '{}' };
  try {
    if (e.httpMethod === 'POST') {       // tracker -> outside world (Zapier etc.)
      if (E.SIMPRO_WEBHOOK) await fetch(E.SIMPRO_WEBHOOK, { method: 'POST', headers: H, body: e.body });
      return { statusCode: 200, headers: H, body: '{"ok":true}' };
    }
    const [j, k] = await Promise.all([jobs(), E.SIMPRO_CONTRACTS_PATH ? get(E.SIMPRO_CONTRACTS_PATH, {}).then(a => a.map(mapContract)) : []]);
    return { statusCode: 200, headers: H, body: JSON.stringify({ jobs: j, renewals: k, at: new Date().toISOString() }) };
  } catch (err) { return { statusCode: 502, headers: H, body: err.message }; }
};
