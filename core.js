/* Pure data helpers. No network, telemetry, or third-party dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TravelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const collections = ['days', 'stops', 'transports', 'hotels', 'tasks', 'expenses', 'suggestions'];
  const clone = x => JSON.parse(JSON.stringify(x));
  function canonical(x) {
    if (x === undefined) return 'undefined';
    if (x === null || typeof x !== 'object') return JSON.stringify(x);
    if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
    return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
  }
  const equal = (a, b) => canonical(a) === canonical(b);
  function validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1) throw new Error('无法识别的数据格式：需要版本1的旅行备份。');
    if (!data.trip || typeof data.trip.title !== 'string') throw new Error('缺少旅行信息。');
    const s = JSON.stringify(data);
    if (new TextEncoder().encode(s).length > 900000) throw new Error('数据超过900KB。请减少长备注或大图片；单份数据需小于900KB。');
    function walk(v) {
      if (!v || typeof v !== 'object') return;
      for (const k of Object.keys(v)) {
        if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new Error('数据包含不允许的字段。');
        walk(v[k]);
      }
    }
    walk(data);
    for (const name of collections) {
      if (!Array.isArray(data[name]) || data[name].length > 3000) throw new Error('数据集合异常：' + name);
      const ids = new Set();
      for (const item of data[name]) {
        if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) throw new Error('记录编号重复或无效：' + name);
        ids.add(item.id);
      }
    }
    const dayIds = new Set(data.days.map(x => x.id));
    for (const d of data.days) if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) throw new Error('行程日期无效。');
    for (const stop of data.stops) if (!dayIds.has(stop.dayId) || !Number.isFinite(stop.rank) || typeof stop.name !== 'string') throw new Error('景点关联日期或名称无效。');
    for (const e of data.expenses) if (!Number.isFinite(e.amount) || e.amount < 0 || !/^[A-Z]{3}$/.test(e.currency)) throw new Error('记账金额或币种无效。');
    for (const stop of data.stops) if (stop.ticket) {
      if (typeof stop.ticket !== 'object' || Array.isArray(stop.ticket)) throw new Error('票券结构无效。');
      for (const key of ['qrImage','originalImage']) {
        const image = stop.ticket[key];
        if (image && !isTicketImage(image)) throw new Error('票券图片必须是大小受限的内嵌PNG或JPEG，不能使用外部地址。');
      }
    }
    return data;
  }
  function isTicketImage(image) {
    return typeof image === 'string' && image.length <= 450000 && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(image);
  }
  function applySupplement(data, patch) {
    validate(data);
    if (!patch || patch.format !== 'travel-handbook-supplement' || patch.version !== 1 || patch.tripId !== data.trip.id || !/^[a-zA-Z0-9_-]{1,100}$/.test(patch.id||'')) throw new Error('不是同一旅行的有效增量更新。');
    if (JSON.stringify(patch).length > 900000) throw new Error('增量更新文件过大。');
    const out = clone(data);
    if ((out.settings.appliedSupplements || []).includes(patch.id)) return out;
    for (const group of ['stops','tasks']) {
      if (!Array.isArray(patch[group]) || patch[group].length > 50) throw new Error('增量记录数量无效。');
      for (const item of patch[group]) {
        if (!out[group].some(x => x.id === item.id)) {
          const copy = clone(item);
          if (group === 'stops') copy.rank = Math.max(0,...out.stops.filter(x=>x.dayId===copy.dayId).map(x=>x.rank)) + 1;
          out[group].push(copy);
        }
      }
    }
    if (!Array.isArray(patch.dayUpdates) || patch.dayUpdates.length > 8) throw new Error('增量日期结构无效。');
    for (const edit of patch.dayUpdates) {
      const day = out.days.find(x=>x.id===edit.id); if (!day) throw new Error('增量日期不存在。');
      if (typeof edit.title === 'string' && day.title === edit.whenTitle) day.title = edit.title;
      for (const [field,key] of [['summary','appendSummary'],['notes','appendNotes']]) {
        if (typeof edit[key] === 'string' && edit[key] && !(day[field]||'').includes(edit[key])) day[field] = [day[field],edit[key]].filter(Boolean).join('\n');
      }
    }
    out.settings.appliedSupplements = [...(out.settings.appliedSupplements||[]), patch.id];
    out.updatedAt = patch.createdAt || data.updatedAt;
    return validate(out);
  }

  // Targeted, idempotent migration. No other day, ticket, expense or checklist is replaced.
  function applyPlanUpdate(data, patch) {
    validate(data);
    if (!patch || patch.format !== 'travel-handbook-plan-update' || patch.version !== 1 ||
        patch.tripId !== data.trip.id || !/^[a-zA-Z0-9_-]{1,100}$/.test(patch.id||''))
      throw new Error('不是同一旅行的有效行程更新。');
    if (new TextEncoder().encode(JSON.stringify(patch)).length > 300000 ||
        !Array.isArray(patch.stops) || patch.stops.length > 50 ||
        !Array.isArray(patch.removeIds) || !data.days.some(x=>x.id===patch.dayId) ||
        patch.day?.id !== patch.dayId || patch.day?.date !== patch.dayId)
      throw new Error('行程更新结构或日期无效。');
    const out = clone(data);
    out.settings = out.settings || {};
    if ((out.settings.appliedPlanUpdates||[]).includes(patch.id)) return out;
    const previous = out.days.find(x=>x.id===patch.dayId);
    const oldStops = out.stops.filter(x=>x.dayId===patch.dayId);
    const previousById = new Map(oldStops.map(x=>[x.id,x]));
    const patchIds = new Set();
    for (const item of patch.stops) {
      if (item.dayId!==patch.dayId || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id||'') || patchIds.has(item.id))
        throw new Error('更新中有重复或跨日期的景点。');
      if (out.stops.some(x=>x.id===item.id && x.dayId!==patch.dayId)) throw new Error('景点编号与其他日期冲突。');
      patchIds.add(item.id);
    }
    if (typeof patch.disclaimer==='string') out.trip.disclaimer=patch.disclaimer;
    // Keep a small archive of the replaced day, not a duplicate of unrelated private tickets.
    const archive = {id:patch.id,day:clone(previous),stops:clone(oldStops),updatedAt:data.updatedAt};
    out.settings.planUpdateArchives = [...(out.settings.planUpdateArchives||[]).filter(x=>x.id!==patch.id),archive].slice(-3);
    const fresh = patch.stops.map(item=>{
      const prior=previousById.get(item.id); const copy=clone(item);
      if (prior) {
        for (const key of ['status','notes','googleUrl','yangoUrl','mapVerified']) if (prior[key]!==undefined) copy[key]=clone(prior[key]);
        if (prior.mapVerified && prior.address) copy.address=prior.address;
        if (prior.ticket) {copy.ticket=clone(prior.ticket);copy.fixed=prior.fixed;}
      }
      return copy;
    });
    // User-added stops are not silently deleted; keep them after the confirmed sequence and before the terminal.
    const extras=oldStops.filter(x=>!patchIds.has(x.id)&&!patch.removeIds.includes(x.id));
    const terminal=fresh.filter(x=>x.kind==='terminal');
    const sequence=fresh.filter(x=>x.kind!=='terminal').concat(extras,terminal);
    sequence.forEach((x,i)=>x.rank=i+1);
    out.stops=out.stops.filter(x=>x.dayId!==patch.dayId).concat(sequence);
    const nextDay={...clone(previous),...clone(patch.day)};
    if (previous.notes && previous.notes!==patch.day.notes) nextDay.previousNotes=previous.notes;
    if (previous.memo!==undefined) nextDay.memo=clone(previous.memo);
    if (extras.length) nextDay.routeReview=true;
    out.days[out.days.findIndex(x=>x.id===patch.dayId)]=nextDay;
    archive.removedTasks=[];
    for (const edit of patch.taskRemovals||[]) {
      const task=out.tasks.find(x=>x.id===edit.id);
      if (task && task.title===edit.whenTitle) {
        archive.removedTasks.push(clone(task));
        out.tasks=out.tasks.filter(x=>x.id!==edit.id);
      }
    }
    for (const edit of patch.suggestionUpdates||[]) {
      const item=out.suggestions.find(x=>x.id===edit.id);if(item)Object.assign(item,clone(edit));
    }
    for (const edit of patch.hotelUpdates||[]) {
      const item=out.hotels.find(x=>x.id===edit.id);if(!item)continue;
      const priorNote=item.todoNote||'';
      Object.assign(item,clone(edit));
      if(priorNote && priorNote!==edit.todoNote) item.previousTodoNote=priorNote;
    }
    // Image assignment adds a reference only. Private notes and the other days' itineraries stay intact.
    for (const edit of patch.photoAssignments||[]) {
      const item=out.stops.find(x=>x.id===edit.id);if(item && !item.photoId) item.photoId=edit.photoId;
    }
    out.settings.appliedPlanUpdates=[...(out.settings.appliedPlanUpdates||[]),patch.id];
    out.updatedAt=patch.createdAt||data.updatedAt;
    return validate(out);
  }

  function restoreDay(data, dayId) {
    const out = clone(data), original = out.originalPlan?.days?.find(x=>x.id===dayId);
    if (!original) throw new Error('没有这一天的原始底稿。');
    const protectedStops = out.stops.filter(x=>x.dayId===dayId && x.fixed && x.ticket);
    const restored = clone(out.originalPlan.stops.filter(x=>x.dayId===dayId));
    for (const item of protectedStops) if (!restored.some(x=>x.id===item.id)) restored.push({...item,rank:Math.max(0,...restored.map(x=>x.rank))+1});
    out.stops = out.stops.filter(x=>x.dayId!==dayId).concat(restored);
    const index = out.days.findIndex(x=>x.id===dayId); out.days[index] = clone(original);
    if (protectedStops.length) out.days[index].notes = [original.notes,'已购固定演出仍保留，恢复原计划不会删除票券。'].filter(Boolean).join('\n');
    return validate(out);
  }
  function merge(base, local, remote) {
    validate(local); validate(remote);
    const out = clone(remote), conflicts = [];
    function choose(b, l, r, group, id, label) {
      if (equal(l, b)) return r;
      if (equal(r, b) || equal(l, r)) return l;
      conflicts.push({ group, id, label, base: b ?? null, local: l ?? null, remote: r ?? null });
      return r;
    }
    for (const group of collections) {
      const bm = new Map((base[group] || []).map(x => [x.id, x]));
      const lm = new Map(local[group].map(x => [x.id, x]));
      const rm = new Map(remote[group].map(x => [x.id, x]));
      const ids = new Set([...rm.keys(), ...lm.keys(), ...bm.keys()]);
      out[group] = [];
      for (const id of ids) {
        const l = lm.get(id), r = rm.get(id), b = bm.get(id);
        const v = choose(b, l, r, group, id, (l || r || b)?.name || (l || r || b)?.title || id);
        if (v !== undefined) out[group].push(clone(v));
      }
    }
    for (const key of ['trip', 'settings', 'originalPlan']) {
      const v = choose(base[key], local[key], remote[key], key, '', key === 'settings' ? '设置' : key === 'trip' ? '旅行信息' : '原始底稿');
      if (v !== undefined) out[key] = clone(v);
    }
    out.updatedAt = local.updatedAt;
    return { data: out, conflicts };
  }
  function resolve(merged, conflict, side) {
    const v = conflict[side];
    if (collections.includes(conflict.group)) {
      merged[conflict.group] = merged[conflict.group].filter(x => x.id !== conflict.id);
      if (v !== null) merged[conflict.group].push(clone(v));
    } else merged[conflict.group] = clone(v);
    return merged;
  }
  function comparable(doc) { const x = clone(doc); delete x.updatedAt; return x; }
  function dateNumber(s) { return Date.parse(s.slice(0, 10) + 'T00:00:00Z'); }
  function moneyTotals(items) {
    const sums = {};
    for (const x of items) { const amount = Number(x.amount); if (Number.isFinite(amount)) sums[x.currency] = (sums[x.currency] || 0) + amount; }
    return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round((v + Number.EPSILON) * 100) / 100]));
  }
  function dayStops(data, dayId) { return data.stops.filter(x => x.dayId === dayId).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)); }
  function timeConflicts(data, dayId) {
    const list = dayStops(data, dayId).filter(s => s.kind !== 'terminal' && s.status !== 'skipped');
    const messages = [];
    let end = '', prev = null;
    for (const s of list) {
      if (s.start && s.end && s.end <= s.start) messages.push(s.name + '：结束时间不晚于开始时间，请核对。');
      if (s.start && end && s.start < end) messages.push((prev?.name || '上一站') + '与' + s.name + '的时间重叠或顺序冲突。');
      if (s.end) { end = s.end; prev = s; }
    }
    const deps = data.transports.filter(t => t.dayId === dayId).map(t => t.departure.slice(11,16));
    const last = list.filter(s => s.end).at(-1);
    if (last && deps.some(t => t && last.end >= t)) messages.push('至少一段固定交通在最后一站结束前出发，请核对交通衔接。');
    return messages;
  }
  function mapUrl(item, provider) {
    const explicit = provider === 'google' ? item.googleUrl : item.yangoUrl;
    if (explicit) {
      try {
        const u = new URL(explicit);
        const allowed = provider === 'google' ? /(^|\.)(google\.[a-z.]+|goo\.gl)$/.test(u.hostname) : /(^|\.)yango\.com$/.test(u.hostname);
        if (u.protocol === 'https:' && allowed) return u.href;
      } catch (_) { /* Fall back to an encoded name search. */ }
    }
    const q = item.mapQuery || [item.english || item.name, item.address].filter(Boolean).join(', ');
    return provider === 'google' ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) : 'https://maps.yango.com/?text=' + encodeURIComponent(q);
  }
  return { collections, clone, canonical, equal, validate, merge, resolve, comparable, dateNumber, moneyTotals, dayStops, timeConflicts, mapUrl, isTicketImage, applySupplement, applyPlanUpdate, restoreDay };
});
