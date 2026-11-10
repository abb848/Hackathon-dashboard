'use strict';

const POLL_MS = 1000;
const ROW_H = 66;
const ROW_GAP = 10;
const PITCH = ROW_H + ROW_GAP;
const MILESTONE_HOLD_MS = 4500;
const SPOTLIGHT_MS = 4500;
const TAGS_OUT_MS = 450; // matches tags-out in style.css
const PULSE_AFTER_ENTER_MS = 300;
const PULSE_MS = 900;
const BLUE = { line: '#4fc3f7', head: '#e1f5fe', light: 'rgba(79,195,247,0.32)' };
const PURPLE = { line: '#a371f7', head: '#f1e8ff', light: 'rgba(163,113,247,0.32)' };
const SVG_NS = 'http://www.w3.org/2000/svg';
// Primer octicon git-merge-16 (MIT)
const MERGE_ICON = 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Time helpers. The server sends its clock, so every device shows the same time.
// ---------------------------------------------------------------------------
let current = null;     // latest state from the server
let receivedAt = 0;     // Date.now() when it arrived
let serverOffset = 0;   // server clock minus this device's clock

function virtualNow() {
  if (!current) return Date.now();
  return current.now + (Date.now() - receivedAt) * current.rate;
}

function serverNow() {
  return Date.now() + serverOffset;
}

const pad = (n) => String(n).padStart(2, '0');

function hhmm(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function hhmmss(ms) {
  return `${hhmm(ms)}:${pad(new Date(ms).getSeconds())}`;
}

function ago(ms, now) {
  const mins = Math.floor(Math.max(0, now - ms) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// HUD numbers: each changed digit traces its outline, then fills in.
// ---------------------------------------------------------------------------
class HudNumber {
  constructor(el, size) {
    this.el = el;
    this.size = size;
    this.text = '';
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `700 ${size}px "Space Grotesk"`;
    let width = 0;
    for (const d of '0123456789') width = Math.max(width, ctx.measureText(d).width);
    const m = ctx.measureText('0123456789');
    this.width = Math.ceil(width);
    // Same baseline as CSS text with line-height 1
    this.baseline = (size - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
  }

  set(value) {
    const next = String(value);
    if (next === this.text) return;
    const prev = this.text.padStart(next.length, ' ');
    this.text = next;

    const slots = [...this.el.children];
    while (slots.length < next.length) {
      const slot = document.createElement('span');
      slot.className = 'digit';
      slot.style.width = `${this.width}px`;
      slot.style.height = `${this.size}px`;
      this.el.prepend(slot);
      slots.unshift(slot);
    }
    while (slots.length > next.length) slots.shift().remove();

    let delay = 0;
    [...next].forEach((ch, i) => {
      if (ch === prev[i]) return;
      this.swap(slots[i], ch, delay);
      delay += 90;
    });
  }

  swap(slot, ch, delay) {
    for (const old of slot.querySelectorAll('.glyph:not(.out)')) {
      old.classList.add('out');
      setTimeout(() => old.remove(), 320);
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'glyph trace');
    svg.setAttribute('width', this.width);
    svg.setAttribute('height', this.size);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', this.width / 2);
    text.setAttribute('y', this.baseline);
    text.setAttribute('text-anchor', 'middle');
    text.style.fontSize = `${this.size}px`;
    text.style.setProperty('--dash', String(Math.round(this.size * 4.5)));
    text.style.setProperty('--stroke', String(Math.max(1.5, this.size / 90)));
    text.style.animationDelay = `${delay}ms`;
    text.textContent = ch;
    svg.append(text);
    slot.append(svg);
  }
}

// ---------------------------------------------------------------------------
// PR rows. Rows sit in fixed slots and slide between them with transforms.
// ---------------------------------------------------------------------------
function safeUrl(url, prefix) {
  return typeof url === 'string' && url.startsWith(prefix) ? url : null;
}

function initials(name) {
  return (name || '?').replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
}

function makeRow(pr, isMergedList) {
  const row = document.createElement('a');
  row.className = 'row';
  row.target = '_blank';
  row.rel = 'noopener noreferrer';
  const href = safeUrl(pr.url, 'https://github.com/');
  if (href) row.href = href;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = initials(pr.author);
  const src = safeUrl(pr.avatar, 'https://');
  if (src) {
    const img = document.createElement('img');
    const url = new URL(src);
    url.searchParams.set('s', '88');
    img.src = url.toString();
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.remove();
    avatar.append(img);
  }

  const cell = (cls) => {
    const el = document.createElement('div');
    el.className = cls;
    return el;
  };
  const title = cell('row-title');
  const tags = cell('row-tags');
  const tagNew = document.createElement('span');
  tagNew.className = 'tag tag-new';
  tagNew.textContent = 'NEW';
  const author = document.createElement('span');
  author.className = 'tag-author';
  tags.append(tagNew, author);
  const wth = cell('tag tag-wth');
  wth.textContent = 'WTH';
  const badge = cell('badge');
  badge.hidden = true;
  const repo = cell('row-repo');
  const num = cell('row-num');
  const when = cell('row-ago');
  row.append(avatar);
  if (isMergedList) {
    const icon = document.createElementNS(SVG_NS, 'svg');
    icon.setAttribute('class', 'merge-icon');
    icon.setAttribute('viewBox', '0 0 16 16');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', MERGE_ICON);
    path.setAttribute('fill', 'currentColor');
    icon.append(path);
    row.append(icon);
  }
  row.append(title, tags, wth, badge);
  if (isMergedList) {
    const stamp = cell('tag tag-merged');
    stamp.textContent = 'MERGED';
    row.append(stamp);
  }
  row.append(repo, num, when);
  row._cells = { title, author, wth, badge, repo, num, when };
  return row;
}

function fillRow(row, pr, milestoneByKey, now, isMergedList) {
  const c = row._cells;
  c.title.textContent = pr.title;
  c.author.textContent = `@${pr.author}`;
  c.wth.hidden = !pr.wth;
  c.repo.textContent = pr.repo_name;
  c.num.textContent = `#${pr.number}`;
  c.when.textContent = ago(isMergedList ? pr.merged : pr.created, now);
  const threshold = isMergedList ? undefined : milestoneByKey.get(pr.key);
  row.classList.toggle('is-milestone', threshold !== undefined);
  c.badge.hidden = threshold === undefined;
  if (threshold !== undefined) c.badge.textContent = `PR #${threshold} OF THE DAY`;
}

class RowList {
  constructor(el, isMergedList) {
    this.el = el;
    this.isMergedList = isMergedList;
    this.rows = new Map(); // key -> { el, pr, slot }
  }

  update(prs, milestoneByKey, animate) {
    const keys = new Set(prs.map((p) => p.key));
    const newKeys = prs.filter((p) => !this.rows.has(p.key)).map((p) => p.key);
    const shift = newKeys.length;
    const arrivals = []; // { slot, delay } for each new row, used to start the pulses

    // Rows pushed off the end slide down with the rest and fade out
    for (const [key, row] of this.rows) {
      if (!keys.has(key)) {
        if (animate) {
          row.el.style.transform = `translateY(${(row.slot + shift) * PITCH}px)`;
          row.el.classList.add('leaving');
          setTimeout(() => row.el.remove(), 800);
        } else {
          row.el.remove();
        }
        this.rows.delete(key);
      }
    }

    const now = virtualNow();
    prs.forEach((pr, i) => {
      let row = this.rows.get(pr.key);
      if (!row) {
        row = { el: makeRow(pr, this.isMergedList) };
        this.rows.set(pr.key, row);
        this.el.append(row.el);
        if (animate) {
          // Oldest new PR appears first, newest last at the top
          const order = shift - 1 - newKeys.indexOf(pr.key);
          const delay = 450 + order * 220;
          const el = row.el;
          el.style.setProperty('--enter-delay', `${delay}ms`);
          el.classList.add('entering', this.isMergedList ? 'merge-glow' : 'spotlight');
          arrivals.push({ slot: i, delay, pr });
          if (!this.isMergedList) {
            setTimeout(() => el.classList.add('spotlight-out'), delay + SPOTLIGHT_MS);
            setTimeout(() => el.classList.remove('spotlight', 'spotlight-out'), delay + SPOTLIGHT_MS + TAGS_OUT_MS);
          }
        }
      }
      row.slot = i;
      row.pr = pr;
      row.el.style.transform = `translateY(${i * PITCH}px)`;
      fillRow(row.el, pr, milestoneByKey, now, this.isMergedList);
    });
    return arrivals;
  }

  tick(milestoneByKey) {
    const now = virtualNow();
    for (const row of this.rows.values()) fillRow(row.el, row.pr, milestoneByKey, now, this.isMergedList);
  }
}

// ---------------------------------------------------------------------------
// Background: a slowly drifting hexagon grid drawn into a few large canvases
// that move together with one transform, so the browser only composites it.
// ---------------------------------------------------------------------------
class HexBackground {
  constructor(world) {
    this.world = world;
    this.chunk = 256; // small chunks waste less memory off screen, which matters at 4K
    this.r = 34;
    this.rowStep = Math.sqrt(3) * this.r;
    this.colStep = 1.5 * this.r;
    this.seed = Math.floor(Math.random() * 2 ** 31);
    this.chunks = new Map();
    this.x = Math.random() * 100000;
    this.y = Math.random() * 100000;
    this.angle = Math.floor(Math.random() * 8) * (Math.PI / 4);
    this.turn = null;
    this.nextTurn = performance.now() + this.turnGap();
    this.speed = 7; // px per second
    this.pixelScale = 1;
    this.lastFrame = performance.now();
    this.lastChunkCheck = 0;
    requestAnimationFrame((t) => this.frame(t));
  }

  turnGap() {
    return 35000 + Math.random() * 45000;
  }

  resize(scale) {
    const ps = scale * (window.devicePixelRatio || 1);
    if (Math.abs(ps - this.pixelScale) < 0.01 && this.chunks.size) return;
    this.pixelScale = ps;
    for (const c of this.chunks.values()) c.remove();
    this.chunks.clear();
    this.updateChunks();
  }

  hash(c, r) {
    let h = (c * 374761393 + r * 668265263 + this.seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  hexPath(ctx, cx, cy, r) {
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      const px = cx + r * Math.cos(a);
      const py = cy + r * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  hexPoints(cx, cy, r) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
    }
    return pts.join(' ');
  }

  // Hexagons around a point (in 1920x1080 frame coordinates) light up in a wave
  ripple(fx, fy, colour, delay) {
    const R = 300;
    const wx = fx + this.x;
    const wy = fy + this.y;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ripple');
    svg.setAttribute('width', 2 * R);
    svg.setAttribute('height', 2 * R);
    svg.setAttribute('viewBox', `${wx - R} ${wy - R} ${2 * R} ${2 * R}`);
    svg.style.left = `${wx - R}px`;
    svg.style.top = `${wy - R}px`;
    svg.style.color = colour;
    const c0 = Math.floor((wx - R) / this.colStep);
    const c1 = Math.ceil((wx + R) / this.colStep);
    for (let c = c0; c <= c1; c++) {
      const cx = c * this.colStep;
      const offset = (c & 1) ? this.rowStep / 2 : 0;
      const r0 = Math.floor((wy - R - offset) / this.rowStep);
      const r1 = Math.ceil((wy + R - offset) / this.rowStep);
      for (let row = r0; row <= r1; row++) {
        const cy = row * this.rowStep + offset;
        const dist = Math.hypot(cx - wx, cy - wy);
        if (dist > R) continue;
        const hex = document.createElementNS(SVG_NS, 'polygon');
        hex.setAttribute('points', this.hexPoints(cx, cy, this.r - 2));
        hex.setAttribute('opacity', (1 - dist / R).toFixed(2));
        hex.style.animationDelay = `${delay + dist * 1.6}ms`;
        svg.append(hex);
      }
    }
    this.world.append(svg);
    setTimeout(() => svg.remove(), delay + R * 1.6 + 1300);
  }

  drawChunk(i, j) {
    const size = this.chunk;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(size * this.pixelScale);
    canvas.height = Math.ceil(size * this.pixelScale);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    canvas.style.left = `${i * size}px`;
    canvas.style.top = `${j * size}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(this.pixelScale, this.pixelScale);
    ctx.lineWidth = 1;
    const x0 = i * size;
    const y0 = j * size;
    const r = this.r - 0.5;
    const plain = new Path2D();
    const odd = [];
    const c0 = Math.floor((x0 - this.r) / this.colStep);
    const c1 = Math.ceil((x0 + size + this.r) / this.colStep);
    for (let c = c0; c <= c1; c++) {
      const cx = c * this.colStep - x0;
      const offset = (c & 1) ? this.rowStep / 2 : 0;
      const r0 = Math.floor((y0 - this.rowStep - offset) / this.rowStep);
      const r1 = Math.ceil((y0 + size + this.rowStep - offset) / this.rowStep);
      for (let row = r0; row <= r1; row++) {
        const cy = row * this.rowStep + offset - y0;
        const p = this.hash(c, row);
        if (p < 0.06) odd.push([cx, cy, p]);
        else this.hexPath(plain, cx, cy, r);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.stroke(plain);
    for (const [cx, cy, p] of odd) {
      ctx.beginPath();
      this.hexPath(ctx, cx, cy, r);
      if (p < 0.028) {
        ctx.fillStyle = 'rgba(3,169,244,0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(79,195,247,0.2)';
        ctx.stroke();
      } else if (p < 0.05) {
        ctx.strokeStyle = 'rgba(79,195,247,0.18)';
        ctx.stroke();
        ctx.beginPath();
        this.hexPath(ctx, cx, cy, r / 2);
        ctx.strokeStyle = 'rgba(79,195,247,0.22)';
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.025)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.stroke();
      }
    }
    return canvas;
  }

  updateChunks() {
    const size = this.chunk;
    const margin = 32;
    const i0 = Math.floor((this.x - margin) / size);
    const j0 = Math.floor((this.y - margin) / size);
    const i1 = Math.floor((this.x + 1920 + margin) / size);
    const j1 = Math.floor((this.y + 1080 + margin) / size);
    const wanted = new Set();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const key = `${i},${j}`;
        wanted.add(key);
        if (!this.chunks.has(key)) {
          const canvas = this.drawChunk(i, j);
          this.world.append(canvas);
          this.chunks.set(key, canvas);
        }
      }
    }
    for (const [key, canvas] of this.chunks) {
      if (!wanted.has(key)) {
        canvas.remove();
        this.chunks.delete(key);
      }
    }
  }

  frame(t) {
    const dt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;

    if (!this.turn && t >= this.nextTurn) {
      // Turn left or right by 45, 90 or 135 degrees, easing round over a few seconds
      const steps = (1 + Math.floor(Math.random() * 3)) * (Math.random() < 0.5 ? -1 : 1);
      this.turn = { from: this.angle, by: steps * (Math.PI / 4), start: t, length: 6000 + Math.abs(steps) * 3000 };
    }
    if (this.turn) {
      const k = Math.min(1, (t - this.turn.start) / this.turn.length);
      const eased = k * k * (3 - 2 * k);
      this.angle = this.turn.from + this.turn.by * eased;
      if (k === 1) {
        this.turn = null;
        this.nextTurn = t + this.turnGap();
      }
    }

    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
    this.world.style.transform = `translate3d(${-this.x}px, ${-this.y}px, 0)`;
    if (t - this.lastChunkCheck > 1000) {
      this.lastChunkCheck = t;
      this.updateChunks();
    }
    requestAnimationFrame((next) => this.frame(next));
  }
}

// ---------------------------------------------------------------------------
// Celebrations for new and merged PRs: an electric pulse runs from the row up
// the side of the screen into the number, which lands with a shockwave.
// ---------------------------------------------------------------------------
let frameScale = 1;
let background;

// Position of an element in the 1920x1080 design, whatever the screen size
function frameRect(el) {
  const r = el.getBoundingClientRect();
  const d = document.querySelector('.dash').getBoundingClientRect();
  return {
    left: (r.left - d.left) / frameScale,
    right: (r.right - d.left) / frameScale,
    top: (r.top - d.top) / frameScale,
    bottom: (r.bottom - d.top) / frameScale,
  };
}

function restartClass(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

// Centre of the digits themselves; the number's container can be wider than them
function digitsCentre(el) {
  const first = frameRect(el.firstElementChild);
  const last = frameRect(el.lastElementChild);
  return [(first.left + last.right) / 2, (first.top + first.bottom) / 2];
}

function pulse(points, colour, delay) {
  const d = 'M' + points.map(([x, y]) => `${x} ${y}`).join(' L');
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  const group = document.createElementNS(SVG_NS, 'g');
  const path = (cls, stroke) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', cls);
    p.style.stroke = stroke;
    group.append(p);
    return p;
  };
  const trace = path('pulse-trace', colour.line);
  const glow = path('pulse-glow', colour.line);
  const head = path('pulse-head', colour.head);
  const spark = document.createElementNS(SVG_NS, 'circle');
  const [ex, ey] = points[points.length - 1];
  spark.setAttribute('cx', ex);
  spark.setAttribute('cy', ey);
  spark.setAttribute('r', 8);
  spark.setAttribute('class', 'pulse-spark');
  spark.style.fill = colour.line;
  group.append(spark);
  $('pulses').append(group);

  const timing = { duration: PULSE_MS, delay, easing: 'cubic-bezier(0.55, 0, 0.7, 1)', fill: 'both' };
  trace.style.strokeDasharray = `${len} ${len}`;
  trace.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], timing);
  const HEAD = 80;
  for (const p of [glow, head]) {
    p.style.strokeDasharray = `${HEAD} ${len + HEAD}`;
    p.animate([{ strokeDashoffset: HEAD }, { strokeDashoffset: -len }], timing);
  }
  head.animate([{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }], { duration: 90, iterations: Infinity });
  spark.animate(
    [{ transform: 'scale(0)', opacity: 1 }, { transform: 'scale(4)', opacity: 0 }],
    { duration: 600, delay: delay + PULSE_MS * 0.95, easing: 'ease-out', fill: 'both' },
  );
  group.animate(
    [{ opacity: 1 }, { opacity: 1, offset: 0.65 }, { opacity: 0 }],
    { duration: PULSE_MS + 900, delay, fill: 'both' },
  );

  // A soft light rides along with the pulse head, lighting up whatever it passes
  const light = document.createElement('div');
  light.className = 'pulse-light';
  light.style.setProperty('--light', colour.light);
  $('lights').append(light);
  let travelled = 0;
  const route = points.map(([x, y], i) => {
    if (i) travelled += Math.hypot(x - points[i - 1][0], y - points[i - 1][1]);
    return { transform: `translate(${x}px, ${y}px)`, offset: travelled / len };
  });
  light.animate(route, timing);
  light.animate(
    [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }],
    { duration: PULSE_MS + 300, delay, fill: 'both' },
  );
  setTimeout(() => { group.remove(); light.remove(); }, delay + PULSE_MS + 1000);
}

// Expanding hexagon rings from a point, like a shockwave
function shockwave(x, y, colour, size, delay) {
  for (const [extra, width] of [[0, 4], [160, 2]]) {
    const ring = document.createElementNS(SVG_NS, 'svg');
    ring.setAttribute('class', 'shock');
    ring.setAttribute('viewBox', '-1.1 -1.1 2.2 2.2');
    ring.style.width = ring.style.height = `${size}px`;
    ring.style.left = ring.style.top = `${-size / 2}px`;
    ring.style.color = colour;
    const hex = document.createElementNS(SVG_NS, 'polygon');
    hex.setAttribute('points', '1,0 0.5,0.866 -0.5,0.866 -1,0 -0.5,-0.866 0.5,-0.866');
    hex.style.stroke = colour;
    hex.style.strokeWidth = `${width}px`;
    ring.append(hex);
    $('lights').append(ring);
    ring.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(0.15)`, opacity: 1 },
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 0 },
      ],
      { duration: 1000, delay: delay + extra, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'both' },
    );
    setTimeout(() => ring.remove(), delay + extra + 1100);
  }
}

// The list heading briefly types out who the PR is from, HUD style
function announce(el, text, normal, cls, delay) {
  clearTimeout(el._announce);
  clearInterval(el._typing);
  el._announce = setTimeout(() => {
    el.classList.add('announce', cls);
    let shown = 0;
    el._typing = setInterval(() => {
      shown++;
      el.textContent = text.slice(0, shown);
      if (shown >= text.length) clearInterval(el._typing);
    }, 30);
    el._announce = setTimeout(() => {
      el.classList.remove('announce', cls);
      el.textContent = normal;
    }, 5000);
  }, delay);
}

// Opened PRs travel up the left side into PRS OPENED. Returns when the pulse lands.
function openedPulse(arrival) {
  const rows = frameRect($('latest'));
  const panel = frameRect($('panel-opened'));
  const y = rows.top + arrival.slot * PITCH + ROW_H / 2;
  const py = (panel.top + panel.bottom) / 2;
  const gx = rows.left / 2;
  const start = arrival.delay + PULSE_AFTER_ENTER_MS;
  const land = start + PULSE_MS;
  pulse([[rows.left, y], [gx, y], [gx, py], [panel.left, py]], BLUE, start);
  setTimeout(() => background.ripple(gx, y, BLUE.line, 0), start);
  setTimeout(() => {
    restartClass($('panel-opened'), 'hit');
    restartClass($('n-opened'), 'kick');
    background.ripple(panel.left, py, BLUE.line, 0);
    shockwave(...digitsCentre($('n-opened')), BLUE.line, 520, 0);
  }, land);
  return land;
}

// Merged PRs travel up the right side into MERGED
function mergedPulse(arrival) {
  const rows = frameRect($('merged'));
  const panel = frameRect($('panel-merged'));
  const y = rows.top + ROW_H / 2;
  const py = (panel.top + panel.bottom) / 2;
  const gx = (rows.right + 1920) / 2;
  const start = arrival.delay + PULSE_AFTER_ENTER_MS;
  const land = start + PULSE_MS;
  pulse([[rows.right, y], [gx, y], [gx, py], [panel.right, py]], PURPLE, start);
  setTimeout(() => background.ripple(gx, y, PURPLE.line, 0), start);
  setTimeout(() => {
    restartClass($('panel-merged'), 'pulse');
    restartClass($('n-merged'), 'kick');
    background.ripple(panel.right, py, PURPLE.line, 0);
    shockwave(...digitsCentre($('n-merged')), PURPLE.line, 300, 0);
  }, land);
  return land;
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------
let milestoneBusy = false;

function updateBar(s) {
  if (milestoneBusy) return;
  const p = s.progress;
  const left = $('ms-left');
  const right = $('ms-right');
  const fill = $('ms-fill');
  if (p.next === null) {
    left.textContent = 'ALL MILESTONES REACHED';
    right.textContent = `${s.counts.opened} opened`;
    fill.style.width = '100%';
  } else {
    left.textContent = 'NEXT MILESTONE';
    right.textContent = `${s.counts.opened} / ${p.next} opened`;
    fill.style.width = `${(p.fraction * 100).toFixed(2)}%`;
  }
}

function confetti() {
  const layer = $('confetti');
  const colours = ['#03A9F4', '#4fc3f7', '#ffb74d', '#ffffff', '#81d4fa', '#ff8a65'];
  for (let i = 0; i < 90; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetto';
    piece.style.left = `${Math.random() * 1920}px`;
    piece.style.width = `${10 + Math.random() * 14}px`;
    piece.style.height = `${6 + Math.random() * 10}px`;
    piece.style.background = colours[i % colours.length];
    layer.append(piece);
    const drift = (Math.random() - 0.5) * 360;
    const spin = (Math.random() - 0.5) * 900;
    const anim = piece.animate(
      [
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 0 },
        { opacity: 0.85, offset: 0.08 },
        { opacity: 0.85, offset: 0.85 },
        { transform: `translate(${drift}px, ${1160 + Math.random() * 80}px) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: 3200 + Math.random() * 2600, delay: Math.random() * 900, easing: 'cubic-bezier(0.25, 0.6, 0.4, 1)', fill: 'both' },
    );
    anim.onfinish = () => piece.remove();
  }
}

function fireMilestone(threshold, s) {
  milestoneBusy = true;
  const left = $('ms-left');
  const fill = $('ms-fill');
  const track = $('ms-track');
  const panel = $('panel-opened');
  left.textContent = `MILESTONE ${threshold} REACHED`;
  left.classList.add('hit');
  $('ms-right').textContent = s.progress.next === null ? 'all milestones reached' : `next: ${s.progress.next} opened`;
  fill.style.width = '100%';
  track.classList.add('flash');
  panel.classList.remove('pulse');
  void panel.offsetWidth; // restart the animation
  panel.classList.add('pulse');
  confetti();

  setTimeout(() => {
    track.classList.remove('flash');
    left.classList.remove('hit');
    fill.classList.add('instant');
    fill.style.width = '0%';
    void fill.offsetWidth;
    fill.classList.remove('instant');
    milestoneBusy = false;
    updateBar(current);
  }, MILESTONE_HOLD_MS);
  setTimeout(() => panel.classList.remove('pulse'), 6500);
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
let fillCycle = null;

function updateHeader(s) {
  $('label').textContent = s.label;
  $('subtitle').textContent = s.subtitle;
  $('updated-label').textContent = s.mode === 'replay' ? 'REPLAY' : 'LAST UPDATED';
  $('updated-time').textContent = s.last_updated ? hhmmss(s.last_updated) : '--:--:--';
  $('updated').classList.toggle('stale', !s.ok);

  const cycle = `${s.cycle_start}/${s.cycle_ms}`;
  if (cycle !== fillCycle) {
    fillCycle = cycle;
    const el = $('updated-fill');
    const elapsed = serverNow() - s.cycle_start;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = `updated-fill ${s.cycle_ms}ms linear ${-elapsed}ms both`;
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let numbers;
let latest;
let merged;
let milestoneByKey = new Map();

function apply(s) {
  const prev = current;
  receivedAt = Date.now();
  serverOffset = s.server_time - receivedAt;
  current = s;

  // A restarted replay or server starts again from scratch, without milestone fireworks
  const restarted = prev && (
    s.mode !== prev.mode
    || s.counts.opened < prev.counts.opened
    || (s.mode === 'replay' && s.cycle_start !== prev.cycle_start)
  );
  const animate = prev !== null && !restarted;

  updateHeader(s);

  milestoneByKey = new Map(s.milestones.map((m) => [m.key, m.threshold]));
  const newOpened = latest.update(s.latest_opened, milestoneByKey, animate);
  const newMerged = merged.update(s.latest_merged ? [s.latest_merged] : [], milestoneByKey, animate);

  const known = new Set(prev && !restarted ? prev.milestones.map((m) => m.threshold) : []);
  const fresh = s.milestones.filter((m) => !known.has(m.threshold));
  const milestone = animate && fresh.length ? Math.max(...fresh.map((m) => m.threshold)) : null;

  // Numbers change when the pulses land; they always show the newest state by then
  const land = () => {
    numbers.opened.set(current.counts.opened);
    numbers.merged.set(current.counts.merged);
    numbers.ready.set(current.counts.ready);
    numbers.wth.set(current.counts.wth);
    if (milestone !== null) fireMilestone(milestone, current);
    else updateBar(current);
  };

  let landAt = 0;
  // Arrivals are newest first, and the newest appears last
  if (animate && s.counts.opened > prev.counts.opened && newOpened.length) {
    for (const a of newOpened) landAt = Math.max(landAt, openedPulse(a));
    const a = newOpened[0];
    announce($('latest-title'), `NEW PR  ›  @${a.pr.author}  ›  ${a.pr.repo_name}`,
      'LATEST OPENED', 'announce-new', a.delay);
  }
  if (animate && s.counts.merged > prev.counts.merged && newMerged.length) {
    for (const a of newMerged) landAt = Math.max(landAt, mergedPulse(a));
    const a = newMerged[0];
    announce($('merged-title'), `MERGED  ›  @${a.pr.author}  ›  ${a.pr.repo_name}`,
      'JUST MERGED', 'announce-merged', a.delay);
  }
  if (landAt) setTimeout(land, landAt);
  else land();
}

async function poll() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (response.ok) apply(await response.json());
  } catch {
    // Server unreachable: keep showing what we have
  }
  setTimeout(poll, POLL_MS);
}

function tick() {
  if (current) {
    $('clock').textContent = hhmm(virtualNow());
    latest.tick(milestoneByKey);
    merged.tick(milestoneByKey);
  }
}

async function start() {
  await Promise.all([
    document.fonts.load('700 100px "Space Grotesk"'),
    document.fonts.load('500 20px "JetBrains Mono"'),
    document.fonts.load('500 20px Inter'),
  ]);
  numbers = {
    opened: new HudNumber($('n-opened'), 230),
    merged: new HudNumber($('n-merged'), 64),
    ready: new HudNumber($('n-ready'), 64),
    wth: new HudNumber($('n-wth'), 64),
  };
  latest = new RowList($('latest'), false);
  merged = new RowList($('merged'), true);

  background = new HexBackground($('bg-world'));
  const fit = () => {
    frameScale = Math.min(innerWidth / 1920, innerHeight / 1080);
    $('frame').style.transform = `scale(${frameScale})`;
    background.resize(frameScale);
  };
  addEventListener('resize', fit);
  fit();

  setInterval(tick, 1000);
  poll();
}

start();
