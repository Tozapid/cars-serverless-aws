// Charts of the page: stacked columns by month with an axis, a legend and a
// tooltip on hover, and a line of one series. Charts of one sync group share
// a crosshair; a drag across a chart zooms it to the dragged months. Plain SVG, no library; the
// columns are those of a sibling project. The colours are the CSS variables
// --series-1 … --series-5 and --series-other, the sixth slot (styles.css),
// assigned in the order of the series, never cycled: a sixth and later series
// is folded into "other" by the caller.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const SLOTS = 5;

  function svg(tag, attrs, children) {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (value != null) node.setAttribute(key, value);
    });
    [].concat(children || []).forEach((child) => child && node.append(child));
    return node;
  }

  function html(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Round steps for the axis: 1, 2, 2.5 or 5 times a power of ten.
  function niceMax(value, ticks) {
    if (value <= 0) return 1;
    const raw = value / ticks;
    const power = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw);
    return step * ticks;
  }

  function color(index, other) {
    return other ? "var(--series-other)" : `var(--series-${Math.min(index, SLOTS - 1) + 1})`;
  }

  // The shared crosshair, as in Grafana: hovering a column of one chart marks
  // the same label on every chart of its sync group (options.sync). Each
  // drawn chart keeps its marker on its node, so redrawn ones drop out.
  function crosshair(group, label) {
    if (!group) return;
    document.querySelectorAll("svg.chart[data-sync]").forEach((node) => {
      if (node.dataset.sync === group && node.crosshair) node.crosshair(label);
    });
  }

  // A drag across the columns zooms the chart to them (onZoom(from, to),
  // labels); a click without a drag does nothing.
  function dragZoom(root, labels, x0, slot, top, height, onZoom) {
    const band = svg("rect", { class: "zoom-band", y: top, height, width: 0, visibility: "hidden" });
    root.append(band);
    let start = null;
    let end = null;
    const indexAt = (event) => {
      const box = root.getBoundingClientRect();
      const scale = box.width / Number(root.getAttribute("width"));
      return Math.max(0, Math.min(labels.length - 1, Math.floor((event.clientX - box.left) / scale / slot - x0 / slot)));
    };
    const paint = () => {
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      band.setAttribute("x", x0 + slot * low);
      band.setAttribute("width", slot * (high - low + 1));
      band.setAttribute("visibility", high > low ? "visible" : "hidden");
    };
    const move = (event) => {
      end = indexAt(event);
      paint();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      band.setAttribute("visibility", "hidden");
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      if (high > low && onZoom) onZoom(labels[low], labels[high]);
      start = null;
    };
    root.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || !onZoom || labels.length < 3) return;
      event.preventDefault();
      start = indexAt(event);
      end = start;
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
  }

  // The visible part of the labels and the button that shows all again.
  function zoomable(labels, wrap, redraw, resetLabel) {
    let range = null;
    const reset = html("button", "ghost chart-reset hidden", resetLabel || "↺");
    reset.type = "button";
    reset.addEventListener("click", () => {
      range = null;
      reset.classList.add("hidden");
      redraw();
    });
    wrap.append(reset);
    return {
      labels: () => (range ? labels.slice(range[0], range[1] + 1) : labels),
      zoom: (from, to) => {
        range = [labels.indexOf(from), labels.indexOf(to)];
        reset.classList.remove("hidden");
        redraw();
      },
    };
  }

  // Series hidden by a click on the legend, per chart (options.key): they
  // stay hidden while the page is open, across redraws.
  const hiddenByChart = {};

  // options: labels (one per column, e.g. days), series ([{key, label,
  // other}]), value(column, key), format(number) for the axis and the
  // tooltip, tick(label) for the labels under the axis, title(label) for
  // the tooltip, extra(label) for one more line of it, height, key (of the
  // chart, to remember the hidden series). Returns an element with the chart
  // and its legend; the chart is drawn again at the width it gets, so that
  // its text and gaps stay in real pixels. A click on a legend entry hides
  // or shows its series, a double click shows it alone; the axis follows
  // what is shown, and every series keeps its colour.
  function columns(options) {
    const { labels } = options;
    // The colour of a series is its place in the whole list, so that hiding
    // one never repaints the others.
    const series = options.series.map((item, position) => ({ ...item, slot: position }));
    if (options.key && !hiddenByChart[options.key]) hiddenByChart[options.key] = new Set();
    const hidden = options.key ? hiddenByChart[options.key] : new Set();
    const wrap = html("div", "chart-wrap");
    const scroller = html("div", "chart-scroll");
    const tip = html("div", "chart-tip hidden");
    tip.setAttribute("role", "status");
    wrap.append(scroller, tip);
    let drawn = 0;
    let available = 640;
    const view = zoomable(labels, wrap, () => draw(available, true), options.resetLabel);
    const draw = (width, force) => {
      available = width;
      const visible = view.labels();
      // Too narrow for its columns, the chart scrolls sideways.
      const size = Math.max(Math.floor(width), visible.length * 6 + 60);
      if (size === drawn && !force) return;
      drawn = size;
      const shown = series.filter((item) => !hidden.has(item.key));
      const totals = visible.map((label) => shown.reduce((sum, item) => sum + Math.max(0, options.value(label, item.key)), 0));
      const max = niceMax(Math.max(0, ...totals), 4);
      scroller.replaceChildren(plot({ ...options, labels: visible, series: shown, onZoom: view.zoom }, totals, max, size, tip, wrap));
    };
    draw(available);
    if (window.ResizeObserver) {
      new ResizeObserver((entries) => draw(entries[0].contentRect.width)).observe(wrap);
    }
    if (series.length > 1) {
      const legend = html("div", "legend");
      const entries = series.map((item) => {
        const entry = html("button", "legend-item");
        entry.type = "button";
        const swatch = html("span", "swatch");
        swatch.style.background = color(item.slot, item.other);
        entry.append(swatch, document.createTextNode(item.label));
        let timer = null;
        // A single click waits a moment, so that a double click is not two.
        entry.addEventListener("click", () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (hidden.has(item.key)) hidden.delete(item.key);
            else hidden.add(item.key);
            refresh();
          }, 220);
        });
        entry.addEventListener("dblclick", () => {
          clearTimeout(timer);
          const alone = series.every((other) => other.key === item.key || hidden.has(other.key)) && !hidden.has(item.key);
          hidden.clear();
          if (!alone) series.forEach((other) => other.key !== item.key && hidden.add(other.key));
          refresh();
        });
        legend.append(entry);
        return [item, entry];
      });
      const refresh = () => {
        entries.forEach(([item, entry]) => {
          entry.classList.toggle("off", hidden.has(item.key));
          entry.setAttribute("aria-pressed", String(!hidden.has(item.key)));
          if (options.legendTitle) entry.title = options.legendTitle;
        });
        draw(available, true);
      };
      wrap.append(legend);
      refresh();
    }
    return wrap;
  }

  function plot(options, totals, max, width, tip, wrap) {
    const { labels, series, value, format } = options;
    const tick = options.tick || ((label) => label);
    const title = options.title || ((label) => label);
    const height = options.height || 200;
    const pad = { top: 8, right: 8, bottom: 22, left: 64 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const y = (amount) => pad.top + plotH - (amount / max) * plotH;
    const slot = plotW / Math.max(1, labels.length);
    const barW = Math.max(3, Math.min(28, slot - 4));

    const root = svg("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": options.label || "", "data-sync": options.sync });
    for (let i = 0; i <= 4; i += 1) {
      const amount = (max / 4) * i;
      root.append(svg("line", { class: "grid", x1: pad.left, x2: width - pad.right, y1: y(amount), y2: y(amount) }));
      const text = svg("text", { class: "axis", x: pad.left - 8, y: y(amount) + 4, "text-anchor": "end" });
      text.textContent = format(amount);
      root.append(text);
    }
    const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotW / 48))));
    const hits = [];

    labels.forEach((label, index) => {
      const x = pad.left + slot * index + (slot - barW) / 2;
      let top = y(0);
      series.forEach((item) => {
        const amount = Math.max(0, value(label, item.key));
        if (!amount) return;
        const h = (amount / max) * plotH;
        // A 2px gap of the surface between stacked segments.
        const gap = top < y(0) ? 2 : 0;
        if (h - gap >= 0.5) {
          root.append(svg("rect", { class: "mark", x, y: top - h, width: barW, height: h - gap, rx: Math.min(3, (h - gap) / 2), fill: color(item.slot, item.other) }));
        }
        top -= h;
      });
      if (index % every === 0) {
        const text = svg("text", { class: "axis", x: x + barW / 2, y: height - 6, "text-anchor": "middle" });
        text.textContent = tick(label);
        root.append(text);
      }
      // The hover target is the whole column, wider than its bar.
      const hit = svg("rect", { class: "hit", x: pad.left + slot * index, y: pad.top, width: slot, height: plotH, tabindex: "0" });
      const show = () => {
        tip.replaceChildren(html("strong", "", title(label)));
        series.slice().reverse().forEach((item) => {
          const amount = value(label, item.key);
          if (!amount) return;
          const row = html("div", "tip-row");
          const swatch = html("span", "swatch");
          swatch.style.background = color(item.slot, item.other);
          row.append(swatch, html("span", "", item.label), html("span", "tip-value", format(amount)));
          tip.append(row);
        });
        if (options.extra) {
          const more = options.extra(label);
          if (more) tip.append(html("div", "tip-extra", more));
        }
        if (series.length > 1) {
          const row = html("div", "tip-row tip-total");
          row.append(html("span", "", options.totalLabel || ""), html("span", "tip-value", format(totals[index])));
          tip.append(row);
        }
        tip.classList.remove("hidden");
        const box = wrap.getBoundingClientRect();
        const bar = hit.getBoundingClientRect();
        const left = Math.min(Math.max(0, bar.left - box.left + bar.width / 2 - tip.offsetWidth / 2), box.width - tip.offsetWidth);
        tip.style.left = `${left}px`;
        crosshair(options.sync, label);
      };
      const hide = () => {
        tip.classList.add("hidden");
        crosshair(options.sync, null);
      };
      hit.addEventListener("mouseenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", hide);
      hit.addEventListener("blur", hide);
      hits.push(hit);
      root.append(hit);
    });
    finish(root, options, labels, hits, pad.left, slot, pad.top, plotH);
    return root;
  }

  // The crosshair line and the zoom of a drawn chart; without a sync group
  // the chart marks only itself.
  function finish(root, options, labels, hits, x0, slot, top, height) {
    const cross = svg("line", { class: "crosshair", y1: top, y2: top + height, visibility: "hidden" });
    root.append(cross);
    root.crosshair = (label) => {
      const index = label == null ? -1 : labels.indexOf(label);
      hits.forEach((hit, position) => hit.classList.toggle("active", position === index));
      if (index < 0) {
        cross.setAttribute("visibility", "hidden");
        return;
      }
      const x = x0 + slot * index + slot / 2;
      cross.setAttribute("x1", x);
      cross.setAttribute("x2", x);
      cross.setAttribute("visibility", "visible");
    };
    if (!options.sync) {
      hits.forEach((hit, index) => {
        hit.addEventListener("mouseenter", () => root.crosshair(labels[index]));
        hit.addEventListener("focus", () => root.crosshair(labels[index]));
        hit.addEventListener("mouseleave", () => root.crosshair(null));
        hit.addEventListener("blur", () => root.crosshair(null));
      });
    }
    dragZoom(root, labels, x0, slot, top, height, options.onZoom);
  }

  // options: labels, value(label) (null: no point), format, tick, title,
  // height, label. One series: a line through its points with a dot each,
  // the axis from the lowest to the highest value.
  function line(options) {
    const wrap = html("div", "chart-wrap");
    const scroller = html("div", "chart-scroll");
    const tip = html("div", "chart-tip hidden");
    tip.setAttribute("role", "status");
    wrap.append(scroller, tip);
    let drawn = 0;
    let available = 640;
    const view = zoomable(options.labels, wrap, () => draw(available, true), options.resetLabel);
    const draw = (width, force) => {
      available = width;
      const visible = view.labels();
      const size = Math.max(Math.floor(width), visible.length * 4 + 60);
      if (size === drawn && !force) return;
      drawn = size;
      scroller.replaceChildren(linePlot({ ...options, labels: visible, onZoom: view.zoom }, size, tip, wrap));
    };
    draw(available);
    if (window.ResizeObserver) {
      new ResizeObserver((entries) => draw(entries[0].contentRect.width)).observe(wrap);
    }
    return wrap;
  }

  function linePlot(options, width, tip, wrap) {
    const { labels, value, format } = options;
    const tick = options.tick || ((label) => label);
    const title = options.title || ((label) => label);
    const height = options.height || 200;
    const pad = { top: 8, right: 12, bottom: 22, left: 72 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const values = labels.map((label) => value(label));
    const known = values.filter((amount) => amount != null);
    const low = known.length ? Math.min(...known) : 0;
    const high = known.length ? Math.max(...known) : 1;
    // A round floor and ceiling around the values.
    const step = niceMax(Math.max(1, high - low), 4) / 4;
    const floor = Math.floor(low / step) * step;
    const top = Math.max(floor + step * 4, Math.ceil(high / step) * step);
    const y = (amount) => pad.top + plotH - ((amount - floor) / (top - floor)) * plotH;
    const slot = plotW / Math.max(1, labels.length);
    const x = (index) => pad.left + slot * index + slot / 2;
    const root = svg("svg", { class: "chart", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": options.label || "", "data-sync": options.sync });
    for (let i = 0; i <= 4; i += 1) {
      const amount = floor + ((top - floor) / 4) * i;
      root.append(svg("line", { class: "grid", x1: pad.left, x2: width - pad.right, y1: y(amount), y2: y(amount) }));
      const text = svg("text", { class: "axis", x: pad.left - 8, y: y(amount) + 4, "text-anchor": "end" });
      text.textContent = format(amount);
      root.append(text);
    }
    const points = values.map((amount, index) => (amount == null ? null : [x(index), y(amount)])).filter(Boolean);
    if (points.length > 1) {
      root.append(svg("polyline", { class: "line", points: points.map((point) => point.join(",")).join(" "), fill: "none", stroke: color(0) }));
    }
    const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotW / 48))));
    const hits = [];
    labels.forEach((label, index) => {
      if (values[index] != null) root.append(svg("circle", { class: "dot", cx: x(index), cy: y(values[index]), r: 3, fill: color(0) }));
      if (index % every === 0) {
        const text = svg("text", { class: "axis", x: x(index), y: height - 6, "text-anchor": "middle" });
        text.textContent = tick(label);
        root.append(text);
      }
      const hit = svg("rect", { class: "hit", x: pad.left + slot * index, y: pad.top, width: slot, height: plotH, tabindex: "0" });
      const show = () => {
        tip.replaceChildren(html("strong", "", title(label)), html("div", "tip-value", values[index] == null ? "—" : format(values[index])));
        tip.classList.remove("hidden");
        const box = wrap.getBoundingClientRect();
        const bar = hit.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(0, bar.left - box.left + bar.width / 2 - tip.offsetWidth / 2), box.width - tip.offsetWidth)}px`;
        crosshair(options.sync, label);
      };
      const hide = () => {
        tip.classList.add("hidden");
        crosshair(options.sync, null);
      };
      hit.addEventListener("mouseenter", show);
      hit.addEventListener("focus", show);
      hit.addEventListener("mouseleave", hide);
      hit.addEventListener("blur", hide);
      hits.push(hit);
      root.append(hit);
    });
    finish(root, options, labels, hits, pad.left, slot, pad.top, plotH);
    return root;
  }

  // The biggest keys of a map of numbers, at most SLOTS; the rest go into
  // "other", the slot after them.
  function topKeys(totals) {
    const keys = Object.entries(totals).filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
    return { kept: keys.slice(0, SLOTS), folded: keys.slice(SLOTS) };
  }

  window.CARS_CHARTS = { columns, line, topKeys, SLOTS };
})();
