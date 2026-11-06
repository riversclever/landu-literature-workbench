/* A compact, safe Markdown renderer for the workbench.
 * Supports headings, paragraphs, lists, blockquotes, tables, code and
 * page citations such as [p.12] or [P1 p.7]. All input is escaped first.
 */
(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(raw, options) {
    const opts = options || {};
    const codes = [];
    let text = String(raw == null ? "" : raw);

    text = text.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push(code);
      return "\u0000C" + (codes.length - 1) + "\u0000";
    });

    text = escapeHtml(text);

    // Cross-paper citations: [P1 p.12]
    text = text.replace(/\[(P\d+)\s*[·,，]?\s*p\.?\s*(\d+)(?:\s*[-–—]\s*(\d+))?\]/gi, function (_, label, start, end) {
      const range = end ? start + "–" + end : start;
      const paperId = opts.paperMap && opts.paperMap[label.toUpperCase()];
      const page = Number(start);
      if (paperId && page > 0) {
        return '<button type="button" class="cite-chip paper-chip" data-paper-id="' +
          escapeHtml(paperId) + '" data-page="' + page + '">' +
          escapeHtml(label.toUpperCase()) + " · p." + escapeHtml(range) + "</button>";
      }
      return '<span class="cite-chip paper-chip">' + escapeHtml(label.toUpperCase()) + " · p." + escapeHtml(range) + "</span>";
    });

    // Same-paper citations: [p.12]
    text = text.replace(/\[p\.?\s*(\d+)(?:\s*[-–—]\s*(\d+))?\]/gi, function (_, start, end) {
      const page = Number(start);
      if (!page) return _;
      const label = end ? "p." + start + "–" + end : "p." + start;
      return '<button type="button" class="cite-chip" data-page="' + page + '">' + escapeHtml(label) + "</button>";
    });

    // Links (http/https only).
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>";
    });

    text = text.replace(/〔推断〕/g, '<span class="claim-tag">推断</span>');
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    text = text.replace(/\u0000C(\d+)\u0000/g, function (_, index) {
      return "<code>" + escapeHtml(codes[Number(index)]) + "</code>";
    });
    return text;
  }

  function isTableSeparator(line) {
    const trimmed = line.trim();
    if (trimmed.indexOf("-") === -1 || trimmed.indexOf("|") === -1) return false;
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?$/.test(trimmed);
  }

  function splitRow(line) {
    let text = line.trim();
    if (text.startsWith("|")) text = text.slice(1);
    if (text.endsWith("|")) text = text.slice(0, -1);
    return text.split("|").map(function (cell) { return cell.trim(); });
  }

  function isBlockStart(lines, index) {
    const line = lines[index];
    const next = lines[index + 1] || "";
    if (!line.trim()) return true;
    if (/^\s{0,3}#{1,6}\s+/.test(line)) return true;
    if (/^\s*```/.test(line)) return true;
    if (/^\s*>/.test(line)) return true;
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) return true;
    if (/^\s*([-+*]|\d+\.)\s+/.test(line)) return true;
    if (line.indexOf("|") !== -1 && isTableSeparator(next)) return true;
    return false;
  }

  function render(text, options) {
    const source = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const lines = source.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i += 1; continue; }

      if (/^\s*```/.test(line)) {
        const lang = line.trim().replace(/^```/, "").trim();
        const code = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1;
        out.push('<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : "") + ">" + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = Math.min(heading[1].length, 4);
        out.push("<h" + level + ">" + renderInline(heading[2], options) + "</h" + level + ">");
        i += 1;
        continue;
      }

      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push("<blockquote><p>" + renderInline(quote.join(" "), options) + "</p></blockquote>");
        continue;
      }

      const listMatch = line.match(/^\s*([-+*]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const ordered = /\d+\./.test(listMatch[1]);
        const items = [];
        while (i < lines.length) {
          const item = lines[i].match(/^\s*([-+*]|\d+\.)\s+(.*)$/);
          if (!item) break;
          const parts = [item[2]];
          i += 1;
          while (i < lines.length && lines[i].trim() && !/^\s*([-+*]|\d+\.)\s+/.test(lines[i]) && !isBlockStart(lines, i)) {
            parts.push(lines[i].trim());
            i += 1;
          }
          items.push(parts.join(" "));
        }
        const tag = ordered ? "ol" : "ul";
        out.push("<" + tag + ">" + items.map(function (item) {
          return "<li>" + renderInline(item, options) + "</li>";
        }).join("") + "</" + tag + ">");
        continue;
      }

      if (line.indexOf("|") !== -1 && isTableSeparator(lines[i + 1] || "")) {
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf("|") !== -1) {
          rows.push(splitRow(lines[i]));
          i += 1;
        }
        let table = '<div class="table-wrap"><table><thead><tr>';
        headers.forEach(function (cell) {
          table += "<th>" + renderInline(cell, options) + "</th>";
        });
        table += "</tr></thead><tbody>";
        rows.forEach(function (row) {
          table += "<tr>";
          headers.forEach(function (_, idx) {
            table += "<td>" + renderInline(row[idx] == null ? "" : row[idx], options) + "</td>";
          });
          table += "</tr>";
        });
        table += "</tbody></table></div>";
        out.push(table);
        continue;
      }

      const paragraph = [line.trim()];
      i += 1;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) {
        paragraph.push(lines[i].trim());
        i += 1;
      }
      out.push("<p>" + renderInline(paragraph.join(" "), options) + "</p>");
    }

    return out.join("\n");
  }

  window.LitMarkdown = { render: render, escapeHtml: escapeHtml };
})();
