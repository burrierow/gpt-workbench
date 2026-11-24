// kimi.com 对话全量提取：在 WebBridge evaluate 的 code 参数中执行。
// 返回 JSON 字符串 {count, scrollH, msgs:[{role, text}]}；调用方用 -o 存文件后解析。
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const scroller = [...document.querySelectorAll('div')]
    .filter(d => d.scrollHeight > d.clientHeight + 300 && d.querySelector('.segment.segment-user,.segment.segment-assistant'))
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!scroller) return JSON.stringify({ err: 'no scroller' });
  const out = []; const seen = new Set();
  const collect = () => {
    document.querySelectorAll('.segment.segment-user,.segment.segment-assistant').forEach(s => {
      const t = (s.innerText || '').trim();
      const k = (s.classList.contains('segment-user') ? 'u' : 'a') + t.slice(0, 100);
      if (t && !seen.has(k)) {
        seen.add(k);
        out.push({ role: s.classList.contains('segment-user') ? 'user' : 'assistant', text: t });
      }
    });
  };
  scroller.scrollTop = 0; await sleep(1000); collect();
  let guard = 0;
  while (guard++ < 80) {
    const prevH = scroller.scrollHeight;
    scroller.scrollTop += scroller.clientHeight * 0.85;
    await sleep(500); collect();
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10 && prevH === scroller.scrollHeight) break;
  }
  return JSON.stringify({ count: out.length, scrollH: scroller.scrollHeight, msgs: out });
})()
