const contextLimit = 8000;
const omitted = '> 较早的对话内容或超长消息开头已省略。\n\n';
const messageHeading = /(?=^## (?:用户|助手|Kimi|GPT|WorkBuddy|千问|User|Assistant)[ \t]*$)/imu;

export function trimChatContext(raw) {
  const text = raw.replace(/\r\n/g, '\n').trim();
  const characters = Array.from(text);
  if (characters.length <= contextLimit) return text;

  const sections = text.split(messageHeading);
  const retained = [];
  let remaining = contextLimit - Array.from(omitted).length;
  for (const section of sections.reverse()) {
    const units = Array.from(section);
    if (units.length > remaining) {
      if (!retained.length) retained.push(units.slice(-remaining).join(''));
      break;
    }
    retained.push(section);
    remaining -= units.length;
  }
  return omitted + retained.reverse().join('').trim();
}
