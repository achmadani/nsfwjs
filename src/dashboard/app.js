(function () {
  'use strict';

  // ------------------------------------------------------------------ utils

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const HISTORY_CAP = 950;
  const KEYS_REFRESH_MS = 10000;
  const STORAGE = { range: 'nsfw-dashboard-range', refresh: 'nsfw-dashboard-refresh', theme: 'nsfw-dashboard-theme' };

  const numberFormat = new Intl.NumberFormat('id-ID');
  const decimalFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 1 });
  const compactFormat = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
  const timeFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateTimeFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  const fmt = {
    int: (value) => numberFormat.format(Math.round(value || 0)),
    dec: (value) => decimalFormat.format(value || 0),
    compact: (value) => (Math.abs(value) >= 10000 ? compactFormat.format(value) : numberFormat.format(Math.round(value || 0))),
    pct: (value) => `${decimalFormat.format(value || 0)}%`,
    ms: (value) => `${decimalFormat.format(value || 0)} ms`,
    mb: (value) => (value >= 1024 ? `${decimalFormat.format(value / 1024)} GB` : `${numberFormat.format(Math.round(value || 0))} MB`),
    time: (t) => timeFormat.format(new Date(t)),
    dateTime: (t) => dateTimeFormat.format(new Date(t)),
    duration(seconds) {
      const s = Math.max(0, Math.round(seconds));
      const d = Math.floor(s / 86400);
      const hr = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d) return `${d} h ${hr} j`;
      if (hr) return `${hr} j ${m} m`;
      if (m) return `${m} m ${s % 60} dtk`;
      return `${s} dtk`;
    },
    ago(t) {
      const seconds = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
      if (seconds < 5) return 'baru saja';
      if (seconds < 60) return `${seconds} dtk lalu`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)} mnt lalu`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)} jam lalu`;
      return fmt.dateTime(t);
    }
  };

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (error) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (error) { /* abaikan */ }
  }

  // Elemen dibuat lewat DOM API; teks selalu lewat textContent (nama client/key
  // adalah data dari luar dan tidak boleh diperlakukan sebagai HTML).
  function build(ns, tag, attrs, children) {
    const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((name) => {
        const value = attrs[name];
        if (value === undefined || value === null || value === false) return;
        if (name === 'text') node.textContent = value;
        else if (name === 'style') Object.keys(value).forEach((prop) => node.style.setProperty(prop, value[prop]));
        else if (name === 'class') node.setAttribute('class', value);
        else node.setAttribute(name, value === true ? '' : value);
      });
    }
    (children || []).forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }
  const h = (tag, attrs, children) => build(null, tag, attrs, children);
  const s = (tag, attrs, children) => build(SVG_NS, tag, attrs, children);
  const $ = (selector, root) => (root || document).querySelector(selector);

  function replace(container, ...nodes) {
    container.replaceChildren(...nodes.filter(Boolean));
  }

  function niceStep(raw) {
    const exponent = Math.pow(10, Math.floor(Math.log10(raw)));
    const fraction = raw / exponent;
    let nice = 10;
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 2.5) nice = 2.5;
    else if (fraction <= 5) nice = 5;
    return nice * exponent;
  }

  function niceScale(maxValue, tickCount) {
    const max = Math.max(maxValue, 1e-9);
    const step = niceStep(max / (tickCount || 4));
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { max: top, ticks };
  }

  // Path batang dengan ujung data membulat 4px dan pangkal persegi.
  function columnPath(x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height));
    return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
  }
  function barPath(x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, height / 2, width));
    return `M${x},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height - r}Q${x + width},${y + height} ${x + width - r},${y + height}H${x}Z`;
  }

  // ---------------------------------------------------------------- tooltip

  const tooltip = $('#tooltip');

  function showTooltip(clientX, clientY, title, rows) {
    const children = [h('div', { class: 'tooltip-title', text: title })];
    rows.forEach((row) => {
      children.push(h('div', { class: 'tooltip-row' }, [
        row.color ? h('span', { class: row.kind === 'rect' ? 'key key-rect' : 'key key-line', style: { '--c': row.color } }) : null,
        h('strong', { text: row.value }),
        h('span', { class: 'name', text: row.name })
      ]));
    });
    replace(tooltip, ...children);
    tooltip.hidden = false;
    const rect = tooltip.getBoundingClientRect();
    let left = clientX + 14;
    let top = clientY + 14;
    if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - 14;
    if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - 14;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  // Interaksi hover dipasang sekali per container; setiap render menyimpan
  // handler baru, sehingga tooltip tetap tampil walau grafik digambar ulang.
  function attachHover(container) {
    if (container.dataset.hoverReady) return;
    container.dataset.hoverReady = '1';
    container.addEventListener('pointermove', (event) => {
      container._pointer = { x: event.clientX, y: event.clientY };
      if (container._hover) container._hover(event.clientX, event.clientY);
    });
    container.addEventListener('pointerleave', () => {
      container._pointer = null;
      if (container._clearHover) container._clearHover();
      hideTooltip();
    });
  }

  function restoreHover(container) {
    if (container._pointer && container._hover) container._hover(container._pointer.x, container._pointer.y);
  }

  function emptyState(container, message) {
    container._hover = null;
    container._clearHover = null;
    replace(container, h('div', { class: 'empty', text: message }));
  }

  // ------------------------------------------------------------ line chart

  function pickTimeStep(spanMs, maxTicks) {
    const steps = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].map((v) => v * 1000);
    return steps.find((step) => spanMs / step <= maxTicks) || steps[steps.length - 1];
  }

  function lineChart(container, options) {
    attachHover(container);
    const series = options.series.filter((item) => item.points.length > 0);
    if (series.length === 0) return emptyState(container, options.empty || 'Belum ada data');

    const width = Math.max(260, container.clientWidth);
    const height = options.height || 220;
    const margin = { top: 12, right: 58, bottom: 26, left: 46 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const t0 = options.t0;
    const t1 = options.t1;
    const maxValue = Math.max(options.minMax || 1, ...series.map((item) => Math.max(...item.points.map((p) => p[1]))));
    const scale = niceScale(maxValue, 4);
    const x = (t) => margin.left + ((t - t0) / (t1 - t0)) * innerW;
    const y = (v) => margin.top + innerH - (v / scale.max) * innerH;
    const gapMs = options.gapMs || 5000;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': options.label });

    // Gabungkan pita yang jaraknya < 10px di layar, supaya burst pendek yang
    // rapat tampil sebagai satu area, bukan deretan garis tipis.
    const pixelBands = [];
    (options.bands || []).forEach(([b0, b1]) => {
      const left = Math.max(x(b0), margin.left);
      const right = Math.min(x(b1), margin.left + innerW);
      if (right <= left) return;
      const last = pixelBands[pixelBands.length - 1];
      if (last && left - last[1] < 10) last[1] = Math.max(last[1], right);
      else pixelBands.push([left, right]);
    });
    pixelBands.forEach(([left, right]) => {
      svg.appendChild(s('rect', { class: 'band', x: left, y: margin.top, width: Math.max(3, right - left), height: innerH }));
    });

    scale.ticks.forEach((tick) => {
      if (tick > 0) svg.appendChild(s('line', { class: 'grid-line', x1: margin.left, x2: margin.left + innerW, y1: y(tick), y2: y(tick) }));
      svg.appendChild(s('text', { class: 'axis-label', x: margin.left - 8, y: y(tick) + 4, 'text-anchor': 'end', text: options.axisFormat(tick) }));
    });
    svg.appendChild(s('line', { class: 'base-line', x1: margin.left, x2: margin.left + innerW, y1: y(0), y2: y(0) }));

    const span = t1 - t0;
    const step = pickTimeStep(span, Math.max(2, Math.floor(innerW / 90)));
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      svg.appendChild(s('text', { class: 'axis-label', x: x(t), y: height - 6, 'text-anchor': 'middle', text: fmt.time(t).slice(0, step >= 60000 ? 5 : 8) }));
    }

    const segmentsOf = (points) => {
      const segments = [];
      let current = [];
      points.forEach((point, index) => {
        if (index > 0 && point[0] - points[index - 1][0] > gapMs) {
          segments.push(current);
          current = [];
        }
        current.push(point);
      });
      if (current.length) segments.push(current);
      return segments;
    };

    series.forEach((item) => {
      segmentsOf(item.points).forEach((segment) => {
        const line = segment.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
        if (series.length === 1 && segment.length > 1) {
          const area = `${line}L${x(segment[segment.length - 1][0]).toFixed(1)},${y(0)}L${x(segment[0][0]).toFixed(1)},${y(0)}Z`;
          svg.appendChild(s('path', { d: area, style: { fill: item.color, 'fill-opacity': '0.10' } }));
        }
        svg.appendChild(s('path', { d: line, fill: 'none', style: { stroke: item.color, 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' } }));
      });
    });

    // Label ujung hanya jika tidak bertabrakan; legend dan tooltip tetap ada.
    const ends = series.map((item) => {
      const last = item.points[item.points.length - 1];
      return { item, last, yPos: y(last[1]) };
    });
    const collide = ends.some((a, i) => ends.some((b, j) => i < j && Math.abs(a.yPos - b.yPos) < 14));
    ends.forEach(({ item, last, yPos }) => {
      svg.appendChild(s('circle', { cx: x(last[0]), cy: yPos, r: 4, style: { fill: item.color, stroke: 'var(--surface)', 'stroke-width': '2' } }));
      if (!collide) svg.appendChild(s('text', { class: 'value-label', x: x(last[0]) + 9, y: yPos + 4, text: options.valueFormat(last[1]) }));
    });

    const cross = s('line', { class: 'crosshair', y1: margin.top, y2: margin.top + innerH, visibility: 'hidden' });
    const hoverDots = series.map((item) => s('circle', { r: 4, visibility: 'hidden', style: { fill: item.color, stroke: 'var(--surface)', 'stroke-width': '2', 'pointer-events': 'none' } }));
    svg.appendChild(cross);
    hoverDots.forEach((dot) => svg.appendChild(dot));
    svg.appendChild(s('rect', { class: 'hit', x: margin.left, y: margin.top, width: innerW, height: innerH }));

    const clear = () => {
      cross.setAttribute('visibility', 'hidden');
      hoverDots.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
    };

    container._clearHover = clear;
    container._hover = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * width;
      if (px < margin.left - 4 || px > margin.left + innerW + 4) { clear(); hideTooltip(); return; }
      const t = t0 + ((px - margin.left) / innerW) * span;
      const base = series[0].points;
      let nearest = base[0];
      base.forEach((point) => { if (Math.abs(point[0] - t) < Math.abs(nearest[0] - t)) nearest = point; });
      const cx = x(nearest[0]);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      const rows = [];
      series.forEach((item, index) => {
        const point = item.points.find((p) => p[0] === nearest[0]);
        if (!point) return;
        hoverDots[index].setAttribute('cx', cx);
        hoverDots[index].setAttribute('cy', y(point[1]));
        hoverDots[index].setAttribute('visibility', 'visible');
        rows.push({ color: item.color, value: options.valueFormat(point[1]), name: item.name });
      });
      const extra = options.tooltipExtra ? options.tooltipExtra(nearest[0]) : [];
      showTooltip(clientX, clientY, fmt.time(nearest[0]), rows.concat(extra));
    };

    replace(container, svg);
    restoreHover(container);
  }

  // ---------------------------------------------------------- column chart

  function columnChart(container, options) {
    attachHover(container);
    const categories = options.categories;
    if (categories.length === 0) return emptyState(container, options.empty || 'Belum ada data');

    const width = Math.max(260, container.clientWidth);
    const height = options.height || 220;
    const margin = { top: 14, right: options.refLine ? 70 : 12, bottom: 26, left: 46 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const stacked = options.mode !== 'grouped';
    const totals = categories.map((_, i) => options.series.reduce((sum, item) => sum + (item.values[i] || 0), 0));
    const maxValue = stacked
      ? Math.max(options.minMax || 1, ...totals, options.refLine ? options.refLine.value : 0)
      : Math.max(options.minMax || 1, ...options.series.map((item) => Math.max(...item.values)));
    const scale = niceScale(maxValue, 4);
    const y = (v) => margin.top + innerH - (v / scale.max) * innerH;
    const band = innerW / categories.length;
    const groupCount = stacked ? 1 : options.series.length;
    const barW = Math.max(2, Math.min(24, ((band * 0.72) - (groupCount - 1) * 2) / groupCount));
    const GAP = 2;

    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': options.label });

    scale.ticks.forEach((tick) => {
      if (tick > 0) svg.appendChild(s('line', { class: 'grid-line', x1: margin.left, x2: margin.left + innerW, y1: y(tick), y2: y(tick) }));
      svg.appendChild(s('text', { class: 'axis-label', x: margin.left - 8, y: y(tick) + 4, 'text-anchor': 'end', text: options.axisFormat(tick) }));
    });

    const labelEvery = Math.max(1, Math.ceil((options.labelWidth || 56) / band));
    const groups = [];

    categories.forEach((category, i) => {
      const center = margin.left + band * i + band / 2;
      const group = s('g', { class: 'mark-group', tabindex: '0', 'aria-label': `${category.title || category.label}` });

      if (stacked) {
        let base = 0;
        const nonZero = options.series.map((item, k) => ({ item, k, value: item.values[i] || 0 })).filter((entry) => entry.value > 0);
        nonZero.forEach((entry, index) => {
          const yTop = y(base + entry.value);
          const yBottom = y(base) - (index > 0 ? GAP : 0);
          const segmentH = Math.max(0, yBottom - yTop);
          base += entry.value;
          if (segmentH <= 0) return;
          const isTop = index === nonZero.length - 1;
          group.appendChild(s('path', {
            class: 'mark',
            d: isTop ? columnPath(center - barW / 2, yTop, barW, segmentH, 4) : `M${center - barW / 2},${yTop}h${barW}v${segmentH}h${-barW}Z`,
            style: { fill: entry.item.color }
          }));
        });
      } else {
        const totalW = groupCount * barW + (groupCount - 1) * GAP;
        options.series.forEach((item, k) => {
          const value = item.values[i] || 0;
          const left = center - totalW / 2 + k * (barW + GAP);
          const top = y(value);
          const barH = y(0) - top;
          if (barH > 0) group.appendChild(s('path', { class: 'mark', d: columnPath(left, top, barW, barH, 4), style: { fill: item.color } }));
          if (options.capLabels && barW >= 18) {
            group.appendChild(s('text', { class: 'value-label-2', x: left + barW / 2, y: top - 5, 'text-anchor': 'middle', text: options.capFormat(value) }));
          }
        });
      }

      group.appendChild(s('rect', { class: 'hit', x: margin.left + band * i, y: margin.top, width: band, height: innerH, style: { cursor: 'default' } }));
      if (i % labelEvery === 0 || options.showAllLabels) {
        svg.appendChild(s('text', { class: 'axis-label', x: center, y: height - 6, 'text-anchor': 'middle', text: category.label }));
      }
      svg.appendChild(group);
      groups.push({ group, category, index: i, center });
    });

    svg.appendChild(s('line', { class: 'base-line', x1: margin.left, x2: margin.left + innerW, y1: y(0), y2: y(0) }));

    if (options.refLine && options.refLine.value > 0) {
      const ry = y(options.refLine.value);
      svg.appendChild(s('line', { class: 'ref-line', x1: margin.left, x2: margin.left + innerW, y1: ry, y2: ry }));
      svg.appendChild(s('text', { class: 'value-label-2', x: margin.left + innerW + 6, y: ry + 4, text: options.refLine.label }));
    }

    const rowsFor = (index) => {
      const rows = options.series.map((item) => ({ color: item.color, kind: 'rect', value: options.valueFormat(item.values[index] || 0), name: item.name }));
      if (options.tooltipExtra) return rows.concat(options.tooltipExtra(index));
      if (stacked && options.series.length > 1) rows.push({ value: options.valueFormat(totals[index]), name: 'Total' });
      return rows;
    };

    container._clearHover = null;
    container._hover = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * width;
      const index = Math.floor((px - margin.left) / band);
      if (index < 0 || index >= categories.length) { hideTooltip(); return; }
      const category = categories[index];
      showTooltip(clientX, clientY, category.title || category.label, rowsFor(index));
    };

    groups.forEach(({ group, category, index }) => {
      group.addEventListener('focus', () => {
        const box = group.getBoundingClientRect();
        showTooltip(box.right, box.top, category.title || category.label, rowsFor(index));
      });
      group.addEventListener('blur', hideTooltip);
    });

    replace(container, svg);
    restoreHover(container);
  }

  // ------------------------------------------------------ horizontal bars

  function barList(container, options) {
    attachHover(container);
    const items = options.items;
    if (items.length === 0 || items.every((item) => !item.value) && options.hideWhenEmpty) {
      return emptyState(container, options.empty || 'Belum ada data');
    }
    const width = Math.max(240, container.clientWidth);
    const rowH = 34;
    const thickness = 16;
    const longest = Math.max(...items.map((item) => item.label.length));
    const labelW = Math.min(150, Math.max(70, longest * 7 + 12));
    const valueW = 56;
    const innerW = width - labelW - valueW;
    const height = items.length * rowH + 8;
    const max = Math.max(1, ...items.map((item) => item.value));
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': options.label });
    const total = items.reduce((sum, item) => sum + item.value, 0);

    svg.appendChild(s('line', { class: 'base-line', x1: labelW, x2: labelW, y1: 4, y2: height - 4 }));

    items.forEach((item, i) => {
      const yMid = 4 + i * rowH + rowH / 2;
      const barW = (item.value / max) * innerW;
      const group = s('g', { class: 'mark-group', tabindex: '0', 'aria-label': `${item.label}: ${options.valueFormat(item.value)}` });
      svg.appendChild(s('text', { class: 'axis-label', x: labelW - 10, y: yMid + 4, 'text-anchor': 'end', style: { fill: 'var(--ink-2)', 'font-size': '12px' }, text: item.label }));
      if (barW > 0) group.appendChild(s('path', { class: 'mark', d: barPath(labelW, yMid - thickness / 2, Math.max(barW, 2), thickness, 4), style: { fill: options.color } }));
      group.appendChild(s('rect', { class: 'hit', x: 0, y: yMid - rowH / 2, width, height: rowH, style: { cursor: 'default' } }));
      svg.appendChild(s('text', { class: 'value-label', x: labelW + Math.max(barW, 0) + 8, y: yMid + 4, text: options.valueFormat(item.value) }));
      svg.appendChild(group);
      const rows = [{ color: options.color, kind: 'rect', value: options.valueFormat(item.value), name: total ? `${fmt.pct((item.value / total) * 100)} dari total` : '' }];
      group.addEventListener('focus', () => {
        const box = group.getBoundingClientRect();
        showTooltip(box.left + labelW, box.top, item.label, rows);
      });
      group.addEventListener('blur', hideTooltip);
      item._rows = rows;
    });

    container._clearHover = null;
    container._hover = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      const py = ((clientY - box.top) / box.height) * height;
      const index = Math.floor((py - 4) / rowH);
      if (index < 0 || index >= items.length) { hideTooltip(); return; }
      showTooltip(clientX, clientY, items[index].label, items[index]._rows);
    };

    replace(container, svg);
    restoreHover(container);
  }

  // ----------------------------------------------------------------- donut

  function donutChart(container, options) {
    attachHover(container);
    const items = options.items;
    const total = items.reduce((sum, item) => sum + item.value, 0);
    if (total === 0) return emptyState(container, options.empty || 'Belum ada data');

    const size = 200;
    const radius = 88;
    const thickness = 22;
    const cx = size / 2;
    const cy = size / 2;
    const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': options.label, style: { width: `${size}px`, flex: 'none' } });
    const arcs = [];
    let angle = -Math.PI / 2;
    const visible = items.filter((item) => item.value > 0);
    const padAngle = visible.length > 1 ? 2 / radius : 0;

    svg.appendChild(s('circle', { cx, cy, r: radius - thickness / 2, fill: 'none', style: { stroke: 'var(--wash)', 'stroke-width': String(thickness) } }));

    visible.forEach((item) => {
      const sweep = (item.value / total) * Math.PI * 2;
      const start = angle + padAngle / 2;
      const end = angle + sweep - padAngle / 2;
      angle += sweep;
      let path;
      if (visible.length === 1) {
        path = s('circle', { class: 'mark', cx, cy, r: radius - thickness / 2, fill: 'none', style: { stroke: item.color, 'stroke-width': String(thickness) } });
      } else {
        const outer = radius;
        const inner = radius - thickness;
        const large = end - start > Math.PI ? 1 : 0;
        const p = (r, a) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
        path = s('path', {
          class: 'mark',
          d: `M${p(outer, start)}A${outer},${outer} 0 ${large} 1 ${p(outer, end)}L${p(inner, end)}A${inner},${inner} 0 ${large} 0 ${p(inner, start)}Z`,
          style: { fill: item.color }
        });
      }
      const group = s('g', { class: 'mark-group', tabindex: '0', 'aria-label': `${item.label}: ${options.valueFormat(item.value)}` }, [path]);
      svg.appendChild(group);
      arcs.push({ group, item, start: start - padAngle / 2, end: end + padAngle / 2 });
    });

    svg.appendChild(s('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', style: { fill: 'var(--ink)', 'font-size': '28px', 'font-weight': '700' }, text: fmt.compact(total) }));
    svg.appendChild(s('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', style: { fill: 'var(--muted)', 'font-size': '12px' }, text: options.centerLabel }));

    const legend = h('div', { class: 'donut-legend' }, items.map((item) => h('div', { class: 'donut-legend-row' }, [
      h('span', { class: 'key key-rect', style: { '--c': item.color } }),
      h('span', { class: 'donut-legend-label', text: item.label }),
      h('strong', { text: options.valueFormat(item.value) }),
      h('span', { class: 'donut-legend-pct', text: fmt.pct(total ? (item.value / total) * 100 : 0) })
    ])));

    const rowsFor = (item) => [{ color: item.color, kind: 'rect', value: options.valueFormat(item.value), name: `${fmt.pct((item.value / total) * 100)} dari total` }];
    arcs.forEach(({ group, item }) => {
      group.addEventListener('focus', () => {
        const box = group.getBoundingClientRect();
        showTooltip(box.right, box.top, item.label, rowsFor(item));
      });
      group.addEventListener('blur', hideTooltip);
    });

    container._clearHover = null;
    container._hover = (clientX, clientY) => {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * size - cx;
      const py = ((clientY - box.top) / box.height) * size - cy;
      const distance = Math.sqrt(px * px + py * py);
      if (distance < radius - thickness - 6 || distance > radius + 8) { hideTooltip(); return; }
      let a = Math.atan2(py, px);
      if (a < -Math.PI / 2) a += Math.PI * 2;
      const hit = arcs.find((arc) => a >= arc.start && a <= arc.end);
      if (hit) showTooltip(clientX, clientY, hit.item.label, rowsFor(hit.item));
      else hideTooltip();
    };

    replace(container, h('div', { class: 'donut-layout' }, [svg, legend]));
    restoreHover(container);
  }

  // ------------------------------------------------------------- sparkline

  function sparkline(points, color) {
    const width = 160;
    const height = 30;
    if (points.length < 2) return null;
    const t0 = points[0][0];
    const t1 = points[points.length - 1][0];
    const max = Math.max(...points.map((p) => p[1]), 1e-9);
    const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * width;
    const y = (v) => height - 3 - (v / max) * (height - 6);
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    const last = points[points.length - 1];
    return s('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' }, [
      s('path', { d, fill: 'none', 'vector-effect': 'non-scaling-stroke', style: { stroke: 'var(--muted)', 'stroke-width': '1.5', 'stroke-linejoin': 'round', opacity: '0.7' } }),
      s('circle', { cx: x(last[0]), cy: y(last[1]), r: 3, style: { fill: color || 'var(--series-1)' } })
    ]);
  }

  // ----------------------------------------------------------------- table

  function table(columns, rows, emptyMessage) {
    if (rows.length === 0) return h('div', { class: 'empty', text: emptyMessage || 'Belum ada data' });
    return h('table', null, [
      h('thead', null, [h('tr', null, columns.map((col) => h('th', { class: col.num ? 'num' : null, text: col.label })))]),
      h('tbody', null, rows.map((row) => h('tr', null, columns.map((col) => {
        const value = col.render ? col.render(row) : row[col.key];
        const cell = h('td', { class: col.num ? 'num' : null });
        if (value instanceof Node) cell.appendChild(value);
        else cell.textContent = value === undefined || value === null ? '–' : String(value);
        return cell;
      }))))
    ]);
  }

  function legend(container, items) {
    replace(container, ...items.map((item) => h('span', { class: 'legend-item' }, [
      h('span', { class: `key key-${item.kind || 'line'}`, style: { '--c': item.color } }),
      h('span', { text: item.label })
    ])));
  }

  // ----------------------------------------------------------------- state

  const state = {
    report: null,
    keys: [],
    keysAt: 0,
    history: [],
    lastT: 0,
    startedAt: null,
    range: Number(storageGet(STORAGE.range)) || 300,
    refreshMs: storageGet(STORAGE.refresh) !== null ? Number(storageGet(STORAGE.refresh)) : 2000,
    timer: null,
    lastSuccess: 0,
    error: null,
    views: {}
  };

  const COLORS = { s1: 'var(--series-1)', s2: 'var(--series-2)', s3: 'var(--series-3)' };
  const REASON_LABELS = {
    missing_key: 'Tanpa key',
    invalid_key: 'Key salah',
    revoked_key: 'Key dicabut',
    local_only: 'Admin dari luar',
    cross_site: 'Lintas situs'
  };

  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'application/json' } });
      let body = null;
      try { body = await response.json(); } catch (error) { body = null; }
      if (!response.ok) throw new Error(`${response.status} ${(body && body.error) || response.statusText}`);
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Timeout');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function mergeHistory(samples) {
    if (!samples || samples.length === 0) return;
    samples.forEach((sample) => {
      if (sample.t > state.lastT) {
        state.history.push(sample);
        state.lastT = sample.t;
      }
    });
    if (state.history.length > HISTORY_CAP) state.history.splice(0, state.history.length - HISTORY_CAP);
  }

  async function tick() {
    clearTimeout(state.timer);
    try {
      const report = await fetchJson(`/admin/report?history_since=${state.lastT}`);
      if (state.startedAt && report.started_at !== state.startedAt) {
        state.history = [];
      }
      state.startedAt = report.started_at;
      mergeHistory(report.resources.history);
      state.report = report;
      if (Date.now() - state.keysAt > KEYS_REFRESH_MS) {
        const keys = await fetchJson('/admin/keys');
        state.keys = keys.keys || [];
        state.keysAt = Date.now();
      }
      state.lastSuccess = Date.now();
      state.error = null;
      render();
    } catch (error) {
      state.error = error.message;
      renderStatus();
    }
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    if (state.refreshMs > 0 && !document.hidden) state.timer = setTimeout(tick, state.refreshMs);
  }

  // ------------------------------------------------------------ derivation

  function windowBounds() {
    const t1 = state.history.length ? state.history[state.history.length - 1].t : Date.now();
    return { t0: t1 - state.range * 1000, t1 };
  }

  function samplesInRange() {
    const { t0 } = windowBounds();
    return state.history.filter((sample) => sample.t >= t0);
  }

  function counterAt(t) {
    let found = null;
    for (let i = state.history.length - 1; i >= 0; i -= 1) {
      if (state.history[i].t <= t) { found = state.history[i]; break; }
    }
    return found ? found.counters : null;
  }

  function bucketSizeMs() {
    if (state.range <= 60) return 5000;
    if (state.range <= 300) return 15000;
    return 30000;
  }

  function bucketize(keys) {
    const bucketMs = bucketSizeMs();
    const { t1 } = windowBounds();
    const end = Math.ceil(t1 / bucketMs) * bucketMs;
    const count = Math.round((state.range * 1000) / bucketMs);
    const start = end - count * bucketMs;
    const first = state.history[0];
    let previous = counterAt(start) || (first && first.t > start ? zeroCounters() : null);
    const buckets = [];
    for (let i = 0; i < count; i += 1) {
      const bucketStart = start + i * bucketMs;
      const bucketEnd = bucketStart + bucketMs;
      const current = counterAt(bucketEnd);
      const values = {};
      keys.forEach((key) => {
        if (!current || !previous) values[key] = 0;
        else values[key] = current[key] >= previous[key] ? current[key] - previous[key] : current[key];
      });
      buckets.push({ start: bucketStart, end: bucketEnd, values });
      if (current) previous = current;
    }
    return buckets;
  }

  function zeroCounters() {
    return { requests: 0, allowed: 0, blocked: 0, moderated: 0, safe: 0, nsfw: 0, errors: 0 };
  }

  // Pita "sedang memproses"; pita yang jaraknya <= 2 sampel digabung agar
  // grafik tidak dipenuhi garis-garis tipis saat trafik rapat.
  function busyBands(samples, intervalMs) {
    const bands = [];
    samples.forEach((sample) => {
      if (sample.state !== 'busy') return;
      const start = sample.t - intervalMs;
      const last = bands[bands.length - 1];
      if (last && start - last[1] <= intervalMs * 2) last[1] = sample.t;
      else bands.push([start, sample.t]);
    });
    return bands;
  }

  // ---------------------------------------------------------------- render

  function card(name) {
    const root = document.querySelector(`[data-card="${name}"]`);
    return {
      root,
      chart: $('[data-chart]', root),
      table: $('[data-table]', root),
      legend: $('[data-legend]', root),
      view: state.views[name] || 'chart'
    };
  }

  function renderStatus() {
    const status = $('#status');
    const label = $('.status-label', status);
    const main = $('#main');
    if (state.error) {
      status.dataset.state = 'error';
      label.textContent = 'Terputus';
      status.title = state.error;
      main.classList.add('is-stale');
    } else if (state.report && !state.report.model_loaded) {
      status.dataset.state = 'loading';
      label.textContent = 'Memuat model';
      status.title = '';
      main.classList.remove('is-stale');
    } else if (state.report) {
      status.dataset.state = 'ok';
      label.textContent = 'Online';
      status.title = '';
      main.classList.remove('is-stale');
    }
    main.classList.toggle('is-loading', !state.report);
    renderUpdated();
  }

  function renderUpdated() {
    const updated = $('#updated');
    if (state.error) {
      updated.textContent = state.lastSuccess ? `Gagal: ${state.error} · data ${fmt.ago(state.lastSuccess)}` : `Gagal: ${state.error}`;
    } else if (state.lastSuccess) {
      updated.textContent = state.refreshMs === 0 ? `Dijeda · ${fmt.ago(state.lastSuccess)}` : `Diperbarui ${fmt.ago(state.lastSuccess)}`;
    }
  }

  function render() {
    const report = state.report;
    if (!report) return;
    renderStatus();

    const service = report.service;
    $('#service-line').textContent = `${service.hostname} · ${service.name} v${service.version} · Node ${service.node_version} · ${service.platform}`;
    $('#since').textContent = `${fmt.dateTime(report.started_at)} (${fmt.duration(report.uptime_seconds)})`;

    renderHero(report);
    renderTiles(report);
    renderCpu(report);
    renderMemory();
    renderThroughput();
    renderModerationRange();
    renderLatency(report);
    renderIdleBusy(report);
    renderBlocked(report);
    renderCategories(report);
    renderStatusCodes(report);
    renderClients(report);
    renderKeys(report);
    renderRoutes(report);
    renderInfo(report);
  }

  function renderHero(report) {
    const m = report.moderation;
    $('#hero-value').textContent = fmt.compact(m.total);
    $('#hero-safe').textContent = fmt.int(m.safe);
    $('#hero-nsfw').textContent = fmt.int(m.nsfw);
    $('#hero-errors').textContent = fmt.int(m.errors);
    const total = m.safe + m.nsfw + m.errors;
    const ratio = $('#hero-ratio');
    ratio.setAttribute('aria-label', `Lolos ${m.safe}, diblokir ${m.nsfw}, error ${m.errors}`);
    replace(ratio, ...[['s1', m.safe], ['s2', m.nsfw], ['s3', m.errors]]
      .filter((entry) => entry[1] > 0)
      .map(([color, value]) => h('span', { style: { 'flex-grow': String(total ? value / total : 0), background: COLORS[color] } })));
  }

  function tile({ label, value, unit, sub, spark, meter }) {
    return h('article', { class: 'card tile' }, [
      h('p', { class: 'tile-label', text: label }),
      h('p', { class: 'tile-value' }, [value, unit ? h('span', { class: 'tile-unit', text: unit }) : null]),
      sub ? h('p', { class: 'tile-sub', text: sub }) : null,
      spark ? h('div', { class: 'tile-spark' }, [spark]) : null,
      meter !== undefined ? h('div', { class: 'meter', role: 'img', 'aria-label': `${fmt.pct(meter)}` }, [h('span', { style: { width: `${Math.min(100, Math.max(0, meter))}%` } })]) : null
    ]);
  }

  function renderTiles(report) {
    const r = report.resources;
    const req = report.requests;
    const samples = samplesInRange();
    const cpuPoints = samples.map((sample) => [sample.t, sample.cpu_percent]);
    const rssPoints = samples.map((sample) => [sample.t, sample.rss_mb]);
    const requestBuckets = bucketize(['requests']).map((bucket) => [bucket.end, bucket.values.requests]);
    const recent = r.per_inference.recent || [];
    const blockedRate = req.total ? (req.blocked / req.total) * 100 : 0;
    const memPct = r.system.total_mem_mb ? (1 - r.system.available_mem_mb / r.system.total_mem_mb) * 100 : 0;

    replace($('#tiles'),
      tile({ label: 'Request masuk', value: fmt.compact(req.total), sub: `${fmt.int(req.allowed)} lolos · ${fmt.int(req.blocked)} diblokir`, spark: sparkline(requestBuckets) }),
      tile({ label: 'Tingkat blokir', value: fmt.dec(blockedRate), unit: '%', sub: `${fmt.int(req.blocked)} ditolak autentikasi`, meter: blockedRate }),
      tile({ label: 'CPU sekarang', value: r.current.cpu_percent === null ? '–' : fmt.dec(r.current.cpu_percent), unit: '%', sub: `puncak ${fmt.pct(r.peak.cpu_percent)} · ${r.cpu_cores} core`, spark: sparkline(cpuPoints) }),
      tile({ label: 'RAM proses', value: fmt.int(r.current.rss_mb), unit: 'MB', sub: `puncak ${fmt.mb(r.peak.rss_mb)}`, spark: sparkline(rssPoints) }),
      tile({ label: 'Inferensi p95', value: fmt.dec(r.per_inference.wall_ms.p95), unit: 'ms', sub: `rata-rata ${fmt.ms(r.per_inference.wall_ms.avg)} · ${fmt.int(r.per_inference.count)}×`, spark: sparkline(recent.map((item) => [item.t, item.wall_ms])) }),
      tile({
        label: 'Memori server',
        value: fmt.dec(memPct),
        unit: '%',
        sub: r.system.available_mem_source === 'MemAvailable'
          ? `tersedia ${fmt.mb(r.system.available_mem_mb)} dari ${fmt.mb(r.system.total_mem_mb)}`
          : `perkiraan kasar (${r.system.available_mem_source}) · total ${fmt.mb(r.system.total_mem_mb)}`,
        meter: memPct
      }),
      tile({ label: 'Uptime', value: fmt.duration(report.uptime_seconds), sub: `load avg ${r.system.load_avg.map((v) => fmt.dec(v)).join(' · ')}` }),
      tile({ label: 'API key aktif', value: fmt.int(report.keys.active), sub: `${fmt.int(report.keys.revoked)} dicabut · ${fmt.int(Object.keys(report.clients).length)} client aktif` })
    );
  }

  function renderCard(name, drawChart, drawTable) {
    const c = card(name);
    c.chart.hidden = c.view !== 'chart';
    c.table.hidden = c.view !== 'table';
    if (c.legend) c.legend.hidden = c.view !== 'chart';
    if (c.view === 'chart') drawChart(c);
    else replace(c.table, drawTable(c));
  }

  function renderCpu(report) {
    const samples = samplesInRange();
    const { t0, t1 } = windowBounds();
    const interval = report.resources.sample_interval_ms;
    $('#cpu-sub').textContent = `100% = satu core penuh · server ${report.resources.cpu_cores} core`;
    renderCard('cpu', (c) => {
      legend(c.legend, [{ label: 'CPU', color: COLORS.s1 }, { label: 'Sedang memproses', kind: 'band' }]);
      lineChart(c.chart, {
        label: 'Grafik CPU proses',
        series: [{ name: 'CPU', color: COLORS.s1, points: samples.map((sample) => [sample.t, sample.cpu_percent]) }],
        bands: busyBands(samples, interval),
        t0, t1,
        minMax: 10,
        gapMs: interval * 3.5,
        axisFormat: (v) => `${fmt.int(v)}%`,
        valueFormat: fmt.pct,
        tooltipExtra: (t) => {
          const sample = samples.find((item) => item.t === t);
          return sample ? [{ value: sample.state, name: 'kondisi' }] : [];
        },
        empty: 'Menunggu sampel CPU…'
      });
    }, () => table([
      { label: 'Waktu', render: (row) => fmt.time(row.t) },
      { label: 'Kondisi', key: 'state' },
      { label: 'CPU', num: true, render: (row) => fmt.pct(row.cpu_percent) },
      { label: 'Diproses', num: true, key: 'in_flight' }
    ], samples.slice().reverse()));
  }

  function renderMemory() {
    const samples = samplesInRange();
    const { t0, t1 } = windowBounds();
    const interval = state.report.resources.sample_interval_ms;
    renderCard('memory', (c) => {
      legend(c.legend, [{ label: 'RSS', color: COLORS.s1 }, { label: 'Heap JS', color: COLORS.s2 }]);
      lineChart(c.chart, {
        label: 'Grafik memori proses',
        series: [
          { name: 'RSS', color: COLORS.s1, points: samples.map((sample) => [sample.t, sample.rss_mb]) },
          { name: 'Heap JS', color: COLORS.s2, points: samples.map((sample) => [sample.t, sample.heap_used_mb]) }
        ],
        t0, t1,
        minMax: 100,
        gapMs: interval * 3.5,
        axisFormat: (v) => fmt.int(v),
        valueFormat: fmt.mb,
        empty: 'Menunggu sampel memori…'
      });
    }, () => table([
      { label: 'Waktu', render: (row) => fmt.time(row.t) },
      { label: 'RSS', num: true, render: (row) => fmt.mb(row.rss_mb) },
      { label: 'Heap JS', num: true, render: (row) => fmt.mb(row.heap_used_mb) }
    ], samples.slice().reverse()));
  }

  function renderThroughput() {
    const buckets = bucketize(['allowed', 'blocked']);
    const seconds = bucketSizeMs() / 1000;
    $('#throughput-sub').textContent = `jumlah per ${seconds} detik`;
    const categories = buckets.map((bucket) => ({ label: fmt.time(bucket.end).slice(0, seconds >= 60 ? 5 : 8), title: `${fmt.time(bucket.start)} – ${fmt.time(bucket.end)}` }));
    renderCard('throughput', (c) => {
      legend(c.legend, [{ label: 'Lolos autentikasi', color: COLORS.s1, kind: 'rect' }, { label: 'Diblokir', color: COLORS.s2, kind: 'rect' }]);
      columnChart(c.chart, {
        label: 'Grafik request masuk',
        categories,
        series: [
          { name: 'Lolos', color: COLORS.s1, values: buckets.map((bucket) => bucket.values.allowed) },
          { name: 'Diblokir', color: COLORS.s2, values: buckets.map((bucket) => bucket.values.blocked) }
        ],
        minMax: 4,
        labelWidth: 64,
        axisFormat: (v) => fmt.int(v),
        valueFormat: fmt.int
      });
    }, () => table([
      { label: 'Interval', render: (row) => `${fmt.time(row.start)} – ${fmt.time(row.end)}` },
      { label: 'Lolos', num: true, render: (row) => fmt.int(row.values.allowed) },
      { label: 'Diblokir', num: true, render: (row) => fmt.int(row.values.blocked) }
    ], buckets.slice().reverse()));
  }

  function renderModerationRange() {
    const { t0 } = windowBounds();
    const first = state.history[0];
    const latest = state.history[state.history.length - 1];
    const base = counterAt(t0) || (first ? zeroCounters() : null);
    const coverageStart = counterAt(t0) ? t0 : (first ? first.t : t0);
    const diff = (key) => (latest && base ? Math.max(0, latest.counters[key] - base[key]) : 0);
    const items = [
      { label: 'Lolos', value: diff('safe'), color: COLORS.s1 },
      { label: 'Diblokir NSFW', value: diff('nsfw'), color: COLORS.s2 },
      { label: 'Error', value: diff('errors'), color: COLORS.s3 }
    ];
    $('#moderation-range-sub').textContent = `sejak ${fmt.time(coverageStart)}`;
    renderCard('moderation-range', (c) => {
      donutChart(c.chart, { label: 'Hasil moderasi dalam rentang', items, centerLabel: 'gambar', valueFormat: fmt.int, empty: 'Belum ada gambar dimoderasi dalam rentang ini' });
    }, () => table([
      { label: 'Hasil', key: 'label' },
      { label: 'Jumlah', num: true, render: (row) => fmt.int(row.value) }
    ], items));
  }

  function renderLatency(report) {
    const inference = report.resources.per_inference;
    const recent = inference.recent || [];
    replace($('#latency-stats'), ...[
      ['p50', inference.wall_ms.p50],
      ['p95', inference.wall_ms.p95],
      ['Maks', inference.wall_ms.max],
      ['CPU / inferensi', inference.cpu_percent.avg, '%'],
      ['Total', inference.count, '×']
    ].map(([label, value, unit]) => h('div', { class: 'stat' }, [
      h('span', { class: 'stat-label', text: label }),
      h('span', { class: 'stat-value' }, [unit === '×' ? fmt.int(value) : fmt.dec(value), h('small', { text: unit || 'ms' })])
    ])));
    $('#latency-sub').textContent = `${recent.length} inferensi terakhir · ms`;
    renderCard('latency', (c) => {
      columnChart(c.chart, {
        label: 'Grafik waktu inferensi',
        categories: recent.map((item) => ({ label: fmt.time(item.t), title: fmt.time(item.t) })),
        series: [{ name: 'Waktu', color: COLORS.s1, values: recent.map((item) => item.wall_ms) }],
        refLine: { value: inference.wall_ms.p95, label: `p95 ${fmt.dec(inference.wall_ms.p95)}` },
        tooltipExtra: (index) => [{ value: fmt.ms(recent[index].cpu_ms), name: 'waktu CPU' }],
        minMax: 10,
        labelWidth: 70,
        axisFormat: (v) => fmt.int(v),
        valueFormat: fmt.ms,
        empty: 'Belum ada inferensi'
      });
    }, () => table([
      { label: 'Waktu', render: (row) => fmt.time(row.t) },
      { label: 'Durasi', num: true, render: (row) => fmt.ms(row.wall_ms) },
      { label: 'Waktu CPU', num: true, render: (row) => fmt.ms(row.cpu_ms) }
    ], recent.slice().reverse(), 'Belum ada inferensi'));
  }

  function renderIdleBusy(report) {
    const r = report.resources;
    const get = (stateName, group, key) => (r[stateName][group] ? r[stateName][group][key] : 0);
    renderCard('idle-busy', (c) => {
      legend(c.legend, [{ label: 'Idle', color: COLORS.s1, kind: 'rect' }, { label: 'Busy', color: COLORS.s2, kind: 'rect' }]);
      if (!r.idle.samples && !r.busy.samples) return emptyState(c.chart, 'Menunggu sampel idle/busy…');
      const cpuBox = h('div', null, [h('p', { class: 'split-title', text: 'CPU (%)' }), h('div')]);
      const ramBox = h('div', null, [h('p', { class: 'split-title', text: 'RSS (MB)' }), h('div')]);
      replace(c.chart, h('div', { class: 'split-charts' }, [cpuBox, ramBox]));
      const common = { mode: 'grouped', height: 250, showAllLabels: true, capLabels: true };
      columnChart(cpuBox.lastChild, Object.assign({}, common, {
        label: 'CPU idle vs busy',
        categories: [{ label: 'Rata-rata' }, { label: 'Puncak' }],
        series: [
          { name: 'Idle', color: COLORS.s1, values: [get('idle', 'cpu_percent', 'avg'), get('idle', 'cpu_percent', 'peak')] },
          { name: 'Busy', color: COLORS.s2, values: [get('busy', 'cpu_percent', 'avg'), get('busy', 'cpu_percent', 'peak')] }
        ],
        axisFormat: (v) => fmt.int(v),
        valueFormat: fmt.pct,
        capFormat: (v) => fmt.int(v)
      }));
      columnChart(ramBox.lastChild, Object.assign({}, common, {
        label: 'RAM idle vs busy',
        categories: [{ label: 'Rata-rata' }, { label: 'Puncak' }],
        series: [
          { name: 'Idle', color: COLORS.s1, values: [get('idle', 'rss_mb', 'avg'), get('idle', 'rss_mb', 'peak')] },
          { name: 'Busy', color: COLORS.s2, values: [get('busy', 'rss_mb', 'avg'), get('busy', 'rss_mb', 'peak')] }
        ],
        axisFormat: (v) => fmt.int(v),
        valueFormat: fmt.mb,
        capFormat: (v) => fmt.int(v)
      }));
    }, () => table([
      { label: 'Kondisi', key: 'label' },
      { label: 'Durasi', num: true, render: (row) => fmt.duration(row.data.seconds || 0) },
      { label: 'CPU rata-rata', num: true, render: (row) => (row.data.cpu_percent ? fmt.pct(row.data.cpu_percent.avg) : '–') },
      { label: 'CPU puncak', num: true, render: (row) => (row.data.cpu_percent ? fmt.pct(row.data.cpu_percent.peak) : '–') },
      { label: 'RSS rata-rata', num: true, render: (row) => (row.data.rss_mb ? fmt.mb(row.data.rss_mb.avg) : '–') },
      { label: 'RSS puncak', num: true, render: (row) => (row.data.rss_mb ? fmt.mb(row.data.rss_mb.peak) : '–') }
    ], [
      { label: 'Idle', data: r.idle },
      { label: 'Busy', data: r.busy },
      { label: 'Startup', data: r.startup }
    ]));
  }

  function renderBlocked(report) {
    const reasons = report.requests.blocked_by_reason;
    const items = Object.keys(REASON_LABELS)
      .map((key) => ({ key, label: REASON_LABELS[key], value: reasons[key] || 0 }))
      .concat(Object.keys(reasons).filter((key) => !REASON_LABELS[key]).map((key) => ({ key, label: key, value: reasons[key] })));
    renderCard('blocked', (c) => {
      if (!report.requests.blocked) return emptyState(c.chart, 'Belum ada request yang diblokir');
      barList(c.chart, { label: 'Request diblokir per alasan', items, color: COLORS.s2, valueFormat: fmt.int });
    }, () => table([
      { label: 'Alasan', key: 'label' },
      { label: 'Kode', render: (row) => h('span', { class: 'mono', text: row.key }) },
      { label: 'Jumlah', num: true, render: (row) => fmt.int(row.value) }
    ], items));
  }

  function renderCategories(report) {
    const flagged = report.moderation.flagged_by_category;
    const thresholds = report.config.thresholds;
    const items = Object.keys(thresholds).map((key) => ({ label: key, value: flagged[key] || 0, threshold: thresholds[key] }));
    renderCard('categories', (c) => {
      if (!report.moderation.nsfw) return emptyState(c.chart, 'Belum ada gambar yang ter-flag');
      barList(c.chart, { label: 'Kategori ter-flag', items, color: COLORS.s2, valueFormat: fmt.int });
    }, () => table([
      { label: 'Kategori', key: 'label' },
      { label: 'Threshold', num: true, render: (row) => fmt.dec(row.threshold) },
      { label: 'Ter-flag', num: true, render: (row) => fmt.int(row.value) }
    ], items));
  }

  function renderStatusCodes(report) {
    const codes = report.requests.by_status;
    const items = Object.keys(codes).sort().map((key) => ({ label: key, value: codes[key] }));
    renderCard('status', (c) => {
      if (items.length === 0) return emptyState(c.chart, 'Belum ada request');
      barList(c.chart, { label: 'Status HTTP', items, color: COLORS.s1, valueFormat: fmt.int });
    }, () => table([
      { label: 'Status', key: 'label' },
      { label: 'Jumlah', num: true, render: (row) => fmt.int(row.value) }
    ], items));
  }

  function shareBar(value, max) {
    return h('span', { class: 'inline-bar' }, [
      fmt.int(value),
      h('span', { class: 'track' }, [h('span', { class: 'fill', style: { width: `${max ? (value / max) * 100 : 0}%` } })])
    ]);
  }

  function renderClients(report) {
    const clients = Object.keys(report.clients).map((id) => Object.assign({ id }, report.clients[id]))
      .sort((a, b) => b.requests - a.requests);
    const max = Math.max(0, ...clients.map((client) => client.requests));
    replace($('#clients-table'), table([
      { label: 'Client', render: (row) => h('span', null, [row.name, row.id !== 'localhost' ? h('span', { class: 'muted mono', text: `  ${row.id}` }) : null]) },
      { label: 'Request', num: true, render: (row) => shareBar(row.requests, max) },
      { label: 'Dimoderasi', num: true, render: (row) => fmt.int(row.moderated) },
      { label: 'NSFW', num: true, render: (row) => fmt.int(row.nsfw) },
      { label: '% NSFW', num: true, render: (row) => (row.moderated ? fmt.pct((row.nsfw / row.moderated) * 100) : '–') },
      { label: 'Terakhir', render: (row) => h('span', { class: 'muted', text: row.last_seen_at ? fmt.ago(row.last_seen_at) : '–' }) }
    ], clients, 'Belum ada client yang mengakses sejak service start'));
  }

  function renderKeys(report) {
    $('#keys-summary').textContent = `${fmt.int(report.keys.active)} key aktif, ${fmt.int(report.keys.revoked)} dicabut`;
    const keys = state.keys.slice().sort((a, b) => (a.active === b.active ? b.created_at.localeCompare(a.created_at) : a.active ? -1 : 1));
    replace($('#keys-table'), table([
      { label: 'Nama', key: 'name' },
      { label: 'Prefix', render: (row) => h('span', { class: 'mono', text: `${row.prefix}…` }) },
      { label: 'Status', render: (row) => h('span', { class: `badge ${row.active ? 'badge-good' : 'badge-muted'}`, text: row.active ? 'Aktif' : 'Dicabut' }) },
      { label: 'Request', num: true, render: (row) => fmt.int(report.clients[row.id] ? report.clients[row.id].requests : 0) },
      { label: 'Dibuat', render: (row) => h('span', { class: 'muted', text: fmt.dateTime(row.created_at) }) }
    ], keys, 'Belum ada API key. Buat dengan: npm run keys -- create "Nama"'));
  }

  function renderRoutes(report) {
    const routes = report.requests.by_route;
    const rows = Object.keys(routes).map((route) => ({ route, count: routes[route] })).sort((a, b) => b.count - a.count);
    const max = Math.max(0, ...rows.map((row) => row.count));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    replace($('#routes-table'), table([
      { label: 'Route', render: (row) => h('span', { class: 'mono', text: row.route }) },
      { label: 'Request', num: true, render: (row) => shareBar(row.count, max) },
      { label: 'Porsi', num: true, render: (row) => fmt.pct(total ? (row.count / total) * 100 : 0) }
    ], rows, 'Belum ada request'));
  }

  function renderInfo(report) {
    const svc = report.service;
    const cfg = report.config;
    const item = (label, value) => h('dl', { class: 'info-item' }, [h('dt', { text: label }), h('dd', null, [value])]);
    const chips = (values) => h('div', { class: 'chips' }, values.map((value) => h('span', { text: value })));
    replace($('#info'),
      item('Host', svc.hostname),
      item('Bind', `${cfg.host}:${cfg.port}`),
      item('PID', String(svc.pid)),
      item('Node.js', svc.node_version),
      item('Platform', svc.platform),
      item('TensorFlow.js', `${svc.tfjs_version}${svc.backend ? ` · ${svc.backend}` : ''}`),
      item('Model', svc.model_source),
      item('Threshold', chips(Object.keys(cfg.thresholds).map((key) => `${key} ≥ ${cfg.thresholds[key]}`))),
      item('Ukuran file maks', `${fmt.dec(cfg.max_file_size_mb)} MB`),
      item('Tipe file', chips(cfg.allowed_mime_types)),
      item('Localhost tanpa key', cfg.local_bypass ? 'Ya' : 'Tidak'),
      item('Interval sampel', `${fmt.int(cfg.resource_sample_ms)} ms`),
      item('Service start', fmt.dateTime(report.started_at)),
      item('Request admin (dashboard)', fmt.int(report.requests.admin))
    );
  }

  // ----------------------------------------------------------------- setup

  function setRange(range) {
    state.range = range;
    storageSet(STORAGE.range, String(range));
    document.querySelectorAll('[data-range]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.range) === range));
    });
  }

  document.querySelectorAll('[data-range]').forEach((button) => {
    button.addEventListener('click', () => {
      setRange(Number(button.dataset.range));
      render();
    });
  });
  setRange([60, 300, 900].indexOf(state.range) === -1 ? 300 : state.range);

  const refreshSelect = $('#refresh');
  refreshSelect.value = String(state.refreshMs);
  if (refreshSelect.value !== String(state.refreshMs)) { state.refreshMs = 2000; refreshSelect.value = '2000'; }
  refreshSelect.addEventListener('change', () => {
    state.refreshMs = Number(refreshSelect.value);
    storageSet(STORAGE.refresh, String(state.refreshMs));
    if (state.refreshMs > 0) tick();
    else { clearTimeout(state.timer); renderUpdated(); }
  });

  document.querySelectorAll('.view-toggle').forEach((toggle) => {
    const name = toggle.closest('[data-card]').dataset.card;
    toggle.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        state.views[name] = button.dataset.view;
        toggle.querySelectorAll('button').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
        hideTooltip();
        render();
      });
    });
  });

  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    storageSet(STORAGE.theme, next);
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
    else clearTimeout(state.timer);
  });

  setInterval(renderUpdated, 1000);
  tick();
})();
