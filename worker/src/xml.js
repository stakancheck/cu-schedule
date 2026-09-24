// Минимальный разбор XML-ответов WebDAV. В Cloudflare Workers нет DOMParser,
// а ответы CalDAV простые: пространства имён отбрасываем, работаем по локальным именам.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1));
  return ENT[e] ?? m;
});

export function parseXml(s) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)(?:[\w.-]+:)?([\w.-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[6] != null) top.text += decode(m[6]);
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const attrs = {};
      for (const a of m[4].matchAll(/(?:[\w.-]+:)?([\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1].toLowerCase()] = decode(a[3] ?? a[4]);
      const node = { name: m[3].toLowerCase(), attrs, children: [], text: "" };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    }
  }
  return root;
}

export function find(node, name) {
  for (const c of node.children) {
    if (c.name === name) return c;
    const r = find(c, name);
    if (r) return r;
  }
  return null;
}

export function findAll(node, name, out = []) {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

export const text = (node) => (node ? node.text.trim() : "");
