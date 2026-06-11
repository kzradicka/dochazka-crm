export function fmtDateTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleString('cs-CZ', {
    day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}
export function fmtTime(d) {
  if (!d) return '';
  return new Date(d).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}
