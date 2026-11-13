const errWith = (message, code) => Object.assign(new Error(message), { code });

const STEP_REF = /\$\{steps\.(\d+)((?:\.[^\s.[\]]+|\[\d+\])*)\}/g;

function resolveStepRef(str, done, where) {
  const misses = [];
  let exact;
  const value = str.replace(STEP_REF, (_, idx, path) => {
    const i = Number(idx);
    const prev = done.find((o) => o.index === i);
    if (!prev) { misses.push(`шаг ${i} ещё не выполнен`); return ""; }
    if (!prev.ok) { misses.push(`шаг ${i} провалился: ${prev.error ?? "?"}`); return ""; }
    let cur = prev.data;
    for (const part of path.match(/[^.[\]]+/g) ?? []) {
      if (cur == null || cur === undefined) { misses.push(`нет ${path} в шаге ${i}`); return ""; }
      if (!Object.hasOwn(Object(cur), part)) { misses.push(`нет ${path} в шаге ${i}`); return ""; }
      cur = cur[part];
    }
    if (cur === undefined || cur === null) { misses.push(`нет ${path} в шаге ${i}`); return ""; }
    if (_ === str) exact = { value: cur };
    return typeof cur === "object" ? JSON.stringify(cur) : String(cur);
  });
  // Молча подставить пустую строку хуже, чем отказать: действие ушло бы не туда.
  // Страховка от кривой ссылки: если после подстановки остался кусок "${steps.",
  // значит шаблон написан не по грамматике, и его текст не должен уехать в действие.
  if (value.includes("${steps.")) misses.push(`ссылка не разобрана: "${value}"`);
  if (misses.length) {
    throw errWith(
      `Подстановка не сработала (${misses.join("; ")}) в аргументе ${where}: "${str}". ` +
        `Ссылка вида ${"${steps.Н.путь}"} читает результат шага Н из этого же пакета.`,
      "InvalidArgument",
    );
  }
  return exact ? exact.value : value;
}

export function resolveArgs(args, done) {
  if (typeof args === "string" && args.includes("${steps.")) return resolveStepRef(args, done, "value");
  if (args === null || typeof args !== "object") return args;
  if (Array.isArray(args)) return args.map((v) => resolveArgs(v, done));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.includes("${steps.")) out[k] = resolveStepRef(v, done, k);
    else out[k] = resolveArgs(v, done);
  }
  return out;
}

