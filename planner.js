"use strict";

const topicPatterns = [
  ["limits", /\blimits?\b/i], ["derivatives", /\bderivatives?|differentiation\b/i],
  ["integrals", /\bintegrals?|integration\b/i], ["continuity", /\bcontinuity\b/i],
  ["probability", /\bprobability\b/i], ["statistics", /\bstatistics|hypothesis test/i],
  ["linear algebra", /\bmatri(?:x|ces)|eigenvectors?|linear algebra\b/i],
  ["mechanics", /\bkinematics|newton|mechanics\b/i], ["cell biology", /\bmitosis|meiosis|cell biology\b/i],
  ["research", /\bresearch|literature review\b/i], ["programming", /\bprogramming|algorithms?|debugging\b/i]
];

function estimateWork(task, typicalMinutes = 120) {
  const text = [task.title, task.details, task.fileText].filter(Boolean).join(" ");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const numbered = (text.match(/(?:^|\n)\s*(?:\d+[.)]|question\s+\d+|problem\s+\d+)/gim) || []).length;
  const demanding = (text.match(/\b(?:calculate|derive|prove|analy[sz]e|evaluate|explain|compare|research|implement|experiment|graph|plot|discuss|justify|interpret)\b/gi) || []).length;
  const simpler = (text.match(/\b(?:identify|list|define|select|match|label)\b/gi) || []).length;
  const fileAvailable = Boolean(task.fileText?.trim());
  const evidence = fileAvailable ? "uploaded homework file" : (task.details?.trim() ? "assignment instructions" : "title only");
  const base = task.type === "exam" ? Math.max(typicalMinutes, 120) : typicalMinutes;
  const complexity = Math.min(2.5, Math.max(0.65, 0.8 + Math.min(words, 1800) / 1200 + Math.min(numbered, 25) * .045 + Math.min(demanding, 30) * .025 - Math.min(simpler, 12) * .01));
  const minutes = Math.max(15, Math.min(2400, Math.round(base * complexity / 5) * 5));
  return {minutes, evidence, words, numbered, demanding, complexity};
}

function analyze(task) {
  const text = task.title + " " + (task.details || "") + " " + (task.fileText || "");
  const inferred = topicPatterns.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
  const topics = task.topics ? [...new Set(task.topics.split(",").map(t => t.trim().toLowerCase()).filter(Boolean))] : inferred;
  const minutes = estimateWork(task, 120).minutes;
  return {topics, minutes: task.minutes ?? minutes};
}

function dateKey(date) {
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  return parts.map(part => String(part).padStart(2, "0")).join("-");
}

function parseCalendar(source) {
  if (!/^BEGIN:VCALENDAR\s*$/im.test(source)) throw new Error("Choose a valid .ics calendar file.");
  const results = [];
  const events = source.replace(/\r?\n[ \t]/g, "").matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g);
  for (const [, body] of events) {
    const fields = {};
    for (const line of body.split(/\r?\n/)) {
      const match = /^([^;:]+)(?:;[^:]*)?:(.*)$/.exec(line);
      if (match) fields[match[1]] = match[2];
    }
    const raw = fields.DTSTART;
    if (fields.STATUS === "CANCELLED" || !raw || !/^\d{8}(T\d{6}Z?)?$/.test(raw) || !fields.SUMMARY) continue;
    const date = raw.slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
    const clock = raw.slice(9, 15).replace(/^(\d{2})(\d{2})(\d{2})$/, "$1:$2:$3");
    const instant = clock ? new Date(date + "T" + clock + (raw.endsWith("Z") ? "Z" : "")) : null;
    if (instant && Number.isNaN(+instant)) continue;
    const title = unescapeCalendar(fields.SUMMARY);
    const course = /\[([^\[\]]+)\]\s*$/.exec(title)?.[1] || "";
    const type = /\b(exams?|midterms?|tests?|quiz(?:zes)?)\b/i.test(title) ? "exam" : "assignment";
    const details = unescapeCalendar(fields.DESCRIPTION || "");
    results.push({
      source: (fields.UID || title) + (fields["RECURRENCE-ID"] || ""),
      title, type, course, due: instant ? dateKey(instant) : date,
      cutoff: instant ? +instant : null,
      details, topics: "",
      assignmentUrl: canvasAssignmentUrl(fields, details, unescapeCalendar(fields["X-ALT-DESC"] || "")),
      attachments: calendarAttachments(details, unescapeCalendar(fields["X-ALT-DESC"] || ""), fields.URL)
    });
  }
  return results;
}

// Only use verified assignment URLs present in the Canvas calendar event.
// A calendar URL is not an assignment URL; never fabricate assignment IDs.
function canvasAssignmentUrl(fields, details, html) {
  const candidates = [fields.URL || ""];
  for (const text of [details, html]) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) candidates.push(match[0]);
    for (const match of text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) candidates.push(match[1]);
  }
  for (const raw of candidates) {
    try {
      const url = new URL(decodeLinkText(raw).replace(/[.,;)\]]+$/, ""));
      if (!/^https:$/.test(url.protocol) || url.hostname !== "canvas.tamu.edu" || url.username || url.password) continue;
      if (!/^\/courses\/\d+\/assignments\/\d+\/?$/.test(url.pathname)) continue;
      // Remove calendar navigation so the link points directly to the assignment.
      url.searchParams.delete("return_to");
      url.hash = "";
      return url.href;
    } catch { /* Ignore invalid URLs. */ }
  }
  return "";
}

function unescapeCalendar(value) {
  return value.replace(/\\([nN,;\\])/g, (_, char) => /n/i.test(char) ? "\n" : char);
}

function decodeLinkText(value) {
  const entities = {amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " "};
  return value.replace(/&(amp|quot|apos|lt|gt|nbsp|#39);/gi, (_, name) =>
    name === "#39" ? "'" : entities[name.toLowerCase()]
  );
}

function calendarAttachments(details, html, baseUrl) {
  const attachments = new Map();
  function add(rawUrl, label) {
    let url;
    try {
      url = new URL(decodeLinkText(rawUrl), baseUrl || undefined);
    } catch {
      return;
    }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return;
    const canvasFile = /^(?:\/courses\/\d+)?\/files\/(\d+)(?:\/|$)/.exec(url.pathname);
    const documentName = /[^/]+\.(?:pdf|docx?|pptx?|xlsx?|txt|tex|zip)$/i.exec(url.pathname);
    const canvasPage = /^\/courses\/\d+\/(?:pages\/[^/]+|modules\/items\/\d+|modules\/\d+)\/?$/.test(url.pathname);
    if (!canvasFile && !documentName && !canvasPage) return;
    const key = canvasFile ? url.origin + "/files/" + canvasFile[1] : url.href;
    if (attachments.has(key)) return;
    let filename = documentName?.[0] || "";
    try {
      filename = decodeURIComponent(filename);
    } catch {
      // Keep the original filename if the URL contains malformed escapes.
    }
    const fallback = canvasFile ? "Canvas file " + canvasFile[1] : "Canvas study material";
    attachments.set(key, {url: url.href, label: label || filename || fallback});
  }

  for (const [, attributes, contents] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    if (!href) continue;
    const title = /(?:^|\s)title\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
    const text = decodeLinkText(contents.replace(/<[^>]*>/g, "")).trim();
    const label = text || decodeLinkText(title?.[1] ?? title?.[2] ?? "").trim();
    add(href[1] ?? href[2] ?? href[3], label);
  }
  for (const [url] of details.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    add(url.replace(/[.,;)\]]+$/, ""));
  }
  return [...attachments.values()];
}

function courseOf(item) {
  return item.course || /\[([^\[\]]+)\]\s*$/.exec(item.title)?.[1] || "";
}

function studySources(task, tasks, library = []) {
  const topics = analyze(task).topics;
  const course = courseOf(task);
  const related = [...tasks, ...library].filter(item => item !== task && course && courseOf(item) === course
    && analyze(item).topics.some(topic => topics.includes(topic)));
  const seen = new Set();
  return [task, ...related].map(item => ({
    title: item.title,
    details: item.details,
    materials: [...(item.attachments || []), ...calendarAttachments(item.details || "", "", "")].filter(material => {
      if (seen.has(material.url)) return false;
      seen.add(material.url);
      return true;
    })
  }));
}

function readStudyGuide(source, taskId) {
  const guide = JSON.parse(source);
  const text = value => typeof value === "string" && value.trim();
  if (guide?.taskId !== taskId || !Array.isArray(guide.questions) || !guide.questions.length
      || guide.questions.length > 50 || !guide.questions.every(question =>
        question && text(question.prompt) && Array.isArray(question.choices)
        && question.choices.length >= 2 && question.choices.length <= 6 && question.choices.every(text)
        && Number.isInteger(question.answer) && question.answer >= 0 && question.answer < question.choices.length
        && text(question.explanation) && text(question.source))) {
    throw new Error("Use the study-guide JSON format from this assessment’s agent export.");
  }
  return guide.questions;
}

function deadline(task) {
  return task.cutoff ?? +new Date(task.due + (task.type === "exam" ? "T00:00:00" : "T23:59:59"));
}

function upcomingTasks(tasks, now = new Date()) {
  const today = dateKey(now);
  return tasks.filter(task => task.cutoff != null ? task.cutoff > +now : task.due >= today);
}

function buildTimeline(tasks, availability, now = new Date()) {
  const minute = 60000;
  const [hour, startMinute] = availability.start.split(":").map(Number);
  const slots = [];
  for (let offset = 0; offset < 90; offset++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, startMinute);
    if (!availability.days.includes(day.getDay())) continue;
    const end = new Date(day);
    end.setMinutes(end.getMinutes() + availability.minutes);
    slots.push({start: Math.max(+day, Math.ceil(+now / minute) * minute), end: +end});
  }
  const sessions = [];
  const unscheduled = [];
  const sorted = upcomingTasks(tasks, now).sort((a, b) => {
    const daysA = Math.max(0, (deadline(a) - +now) / 86400000);
    const daysB = Math.max(0, (deadline(b) - +now) / 86400000);
    if (daysA <= 1 || daysB <= 1) return deadline(a) - deadline(b);
    return (b.priorityScore || 0) - (a.priorityScore || 0) || deadline(a) - deadline(b);
  });
  for (const task of sorted) {
    const due = deadline(task);
    const {topics, minutes} = analyze(task);
    let remaining = minutes;
    const practice = task.type === "exam" && sessions.some(session =>
      session.type === "assignment" && topics.some(topic => session.topics.includes(topic))
    );
    const actions = task.type === "exam"
      ? [practice ? "Review topics from earlier coursework" : "Review exam topics", "Practice questions", "Recall and check weak areas"]
      : ["Work on assignment", "Continue assignment", "Review and prepare to submit"];
    let count = 0;
    const taskSessions = [];
    // Spread work across days first, then use any remaining capacity.
    for (const limit of [60, Infinity]) {
      for (const slot of slots) {
        if (!remaining) break;
        const capacity = Math.floor((Math.min(slot.end, due) - slot.start) / minute);
        if (capacity <= 0) continue;
        const duration = Math.min(remaining, capacity, limit);
        taskSessions.push({title: task.title, type: task.type, topics, start: slot.start, duration});
        slot.start += duration * minute;
        remaining -= duration;
      }
      if (!remaining) break;
    }
    taskSessions.sort((a, b) => a.start - b.start);
    for (const session of taskSessions) {
      session.action = actions[Math.min(count, actions.length - 1)];
      count++;
      sessions.push(session);
    }
    if (remaining) unscheduled.push({title: task.title, remaining});
  }
  return {sessions: sessions.sort((a, b) => a.start - b.start), unscheduled};
}

if (typeof module !== "undefined") module.exports = {estimateWork, analyze, dateKey, parseCalendar, buildTimeline, upcomingTasks, studySources, readStudyGuide};
