import { type Attr, type Handler, unescape, unescapeAttrValue } from "./html.ts";
import { pyLen, pyStrip } from "./str.ts";

const STARTTAG_OPEN = /<[a-zA-Z]/y;
const ENDTAG_OPEN = /<\/[a-zA-Z]/y;
const COMMENT_CLOSE = /--!?>/g;
const COMMENT_ABRUPT_CLOSE = /-?>/y;
const TAGFIND = /([a-zA-Z][^\t\n\r\f />]*)(?:[\t\n\r\f ]|\/(?!>))*/y;
const ATTRFIND = /((?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*)([\t\n\r\f ]*=[\t\n\r\f ]*('[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?(?:[\t\n\r\f ]|\/(?!>))*/y;
const LOCATE_TAGEND = /[a-zA-Z][^\t\n\r\f />]*[\t\n\r\f /]*(?:(?<=['"\t\n\r\f /])[^\t\n\r\f />][^\t\n\r\f /=>]*(?:[\t\n\r\f ]*=[\t\n\r\f ]*(?:'[^']*'|"[^"]*"|(?!['"])[^>\t\n\r\f ]*))?[\t\n\r\f /]*)*>?/y;
const AMP_END = /[\t\n\r\f ;]/g;
const CDATA_CONTENT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes"]);
const RCDATA_CONTENT = new Set(["textarea", "title"]);

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

function unitsBack(text: string, count: number): number {
  let at = text.length;
  for (let left = count; left > 0 && at > 0; left -= 1) {
    const unit = text.charCodeAt(at - 1);
    at -= unit >= 0xdc00 && unit < 0xe000 && at >= 2 && text.charCodeAt(at - 2) >= 0xd800 && text.charCodeAt(at - 2) < 0xdc00 ? 2 : 1;
  }
  return at;
}

export class HTMLParser {
  rawdata = "";
  lasttag = "???";
  private interesting: RegExp | null = null;
  private cdataElem: string | null = null;
  private escapable = true;

  constructor(private readonly handler: Handler) {}

  private pending: string[] = [];
  private pendingLength = 0;
  private threshold = 1;

  feed(data: string): void {
    this.pendingLength += pyLen(data);
    if (this.pendingLength < this.threshold) {
      this.pending.push(data);
      return;
    }
    if (this.pending.length === 0) this.rawdata += data;
    else {
      this.pending.push(data);
      this.rawdata += this.pending.join("");
      this.pending = [];
    }
    this.pendingLength = 0;
    const before = pyLen(this.rawdata);
    this.goahead(false);
    const after = pyLen(this.rawdata);
    this.threshold = after < before ? 1 : after;
  }

  close(): void {
    if (this.pending.length) {
      this.rawdata += this.pending.join("");
      this.pending = [];
      this.pendingLength = 0;
    }
    this.goahead(true);
  }

  private data(text: string): void {
    this.handler.data?.(text);
  }

  private setCdataMode(element: string, escapable: boolean): void {
    this.cdataElem = element.toLowerCase();
    this.escapable = escapable;
    this.interesting = this.cdataElem === "plaintext" ? /$(?![\s\S])/g : new RegExp(`</${this.cdataElem}(?=[\\t\\n\\r\\f />])`, "gi");
  }

  private clearCdataMode(): void {
    this.interesting = null;
    this.cdataElem = null;
    this.escapable = true;
  }

  private goahead(end: boolean): void {
    const rawdata = this.rawdata;
    let i = 0;
    const n = rawdata.length;
    while (i < n) {
      let j: number;
      if (!this.cdataElem) {
        j = rawdata.indexOf("<", i);
        if (j < 0) {
          const amppos = rawdata.lastIndexOf("&");
          const floor = Math.max(i, unitsBack(rawdata, 34));
          if (amppos >= floor) {
            AMP_END.lastIndex = amppos;
            if (!AMP_END.test(rawdata)) break;
          }
          j = n;
        }
      } else {
        const pattern = this.interesting as RegExp;
        pattern.lastIndex = i;
        const match = pattern.exec(rawdata);
        if (match) j = match.index;
        else break;
      }
      if (i < j) this.data(this.escapable ? unescape(rawdata.slice(i, j)) : rawdata.slice(i, j));
      i = j;
      if (i === n) break;
      let k: number;
      if (matchAt(STARTTAG_OPEN, rawdata, i)) k = this.parseStarttag(i);
      else if (rawdata.startsWith("</", i)) k = this.parseEndtag(i);
      else if (rawdata.startsWith("<!--", i)) k = this.parseComment(i);
      else if (rawdata.startsWith("<?", i)) k = this.parsePi(i);
      else if (rawdata.startsWith("<!", i)) k = this.parseHtmlDeclaration(i);
      else if (i + 1 < n || end) {
        this.data("<");
        k = i + 1;
      } else break;
      if (k < 0) {
        if (!end) break;
        if (matchAt(STARTTAG_OPEN, rawdata, i)) {
        } else if (rawdata.startsWith("</", i)) {
          if (i + 2 === n) this.data("</");
          else if (!matchAt(ENDTAG_OPEN, rawdata, i)) this.handler.comment?.(rawdata.slice(i + 2));
        } else if (rawdata.startsWith("<!--", i)) {
          let stop = n;
          for (const suffix of ["--!", "--", "-"]) {
            if (rawdata.endsWith(suffix) && n - suffix.length >= i + 4) {
              stop -= suffix.length;
              break;
            }
          }
          this.handler.comment?.(rawdata.slice(i + 4, stop));
        } else if (rawdata.startsWith("<![CDATA[", i)) this.handler.unknownDecl?.(rawdata.slice(i + 3));
        else if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") this.handler.decl?.(rawdata.slice(i + 2));
        else if (rawdata.startsWith("<!", i)) this.handler.comment?.(rawdata.slice(i + 2));
        else if (rawdata.startsWith("<?", i)) this.handler.pi?.(rawdata.slice(i + 2));
        k = n;
      }
      i = k;
    }
    if (end && i < n) {
      this.data(this.escapable ? unescape(rawdata.slice(i, n)) : rawdata.slice(i, n));
      i = n;
    }
    this.rawdata = rawdata.slice(i);
  }

  private parseHtmlDeclaration(i: number): number {
    const rawdata = this.rawdata;
    if (rawdata.startsWith("<!--", i)) return this.parseComment(i);
    if (rawdata.startsWith("<![CDATA[", i)) {
      const j = rawdata.indexOf("]]>", i + 9);
      if (j < 0) return -1;
      this.handler.unknownDecl?.(rawdata.slice(i + 3, j));
      return j + 3;
    }
    if (rawdata.slice(i, i + 9).toLowerCase() === "<!doctype") {
      const gtpos = rawdata.indexOf(">", i + 9);
      if (gtpos === -1) return -1;
      this.handler.decl?.(rawdata.slice(i + 2, gtpos));
      return gtpos + 1;
    }
    return this.parseBogusComment(i);
  }

  private parseComment(i: number): number {
    const rawdata = this.rawdata;
    let match = matchAt(COMMENT_ABRUPT_CLOSE, rawdata, i + 4);
    if (!match) {
      COMMENT_CLOSE.lastIndex = i + 4;
      match = COMMENT_CLOSE.exec(rawdata);
      if (!match) return -1;
    }
    this.handler.comment?.(rawdata.slice(i + 4, match.index));
    return match.index + match[0].length;
  }

  private parseBogusComment(i: number): number {
    const rawdata = this.rawdata;
    const pos = rawdata.indexOf(">", i + 2);
    if (pos === -1) return -1;
    this.handler.comment?.(rawdata.slice(i + 2, pos));
    return pos + 1;
  }

  private parsePi(i: number): number {
    const rawdata = this.rawdata;
    const pos = rawdata.indexOf(">", i + 2);
    if (pos < 0) return -1;
    this.handler.pi?.(rawdata.slice(i + 2, pos));
    return pos + 1;
  }

  private parseStarttag(i: number): number {
    const endpos = this.checkForWholeStartTag(i);
    if (endpos < 0) return endpos;
    const rawdata = this.rawdata;
    const attrs: Attr[] = [];
    const found = matchAt(TAGFIND, rawdata, i + 1) as RegExpExecArray;
    let k = found.index + found[0].length;
    const tag = (found[1] as string).toLowerCase();
    this.lasttag = tag;
    while (k < endpos) {
      const m = matchAt(ATTRFIND, rawdata, k);
      if (!m) break;
      const name = m[1] as string;
      const rest = m[2];
      let value: string | null = m[3] ?? null;
      if (!rest) value = null;
      else if (value !== null && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) value = value.slice(1, -1);
      if (value) value = unescapeAttrValue(value);
      attrs.push([name.toLowerCase(), value]);
      k = m.index + m[0].length;
    }
    const endText = pyStrip(rawdata.slice(k, endpos));
    if (endText !== ">" && endText !== "/>") {
      this.data(rawdata.slice(i, endpos));
      return endpos;
    }
    if (endText.endsWith("/>")) {
      if (this.handler.startendtag) this.handler.startendtag(tag, attrs);
      else {
        this.handler.starttag?.(tag, attrs);
        this.handler.endtag?.(tag);
      }
    } else {
      this.handler.starttag?.(tag, attrs);
      if (CDATA_CONTENT.has(tag) || tag === "plaintext") this.setCdataMode(tag, false);
      else if (RCDATA_CONTENT.has(tag)) this.setCdataMode(tag, true);
    }
    return endpos;
  }

  private checkForWholeStartTag(i: number): number {
    const rawdata = this.rawdata;
    const match = matchAt(LOCATE_TAGEND, rawdata, i + 1) as RegExpExecArray;
    const j = match.index + match[0].length;
    return rawdata[j - 1] !== ">" ? -1 : j;
  }

  private parseEndtag(i: number): number {
    const rawdata = this.rawdata;
    if (rawdata.indexOf(">", i + 2) < 0) return -1;
    if (!matchAt(ENDTAG_OPEN, rawdata, i)) {
      if (rawdata.slice(i + 2, i + 3) === ">") return i + 3;
      return this.parseBogusComment(i);
    }
    const located = matchAt(LOCATE_TAGEND, rawdata, i + 2) as RegExpExecArray;
    const j = located.index + located[0].length;
    if (rawdata[j - 1] !== ">") return -1;
    const found = matchAt(TAGFIND, rawdata, i + 2) as RegExpExecArray;
    const tag = (found[1] as string).toLowerCase();
    this.handler.endtag?.(tag);
    this.clearCdataMode();
    return j;
  }
}
