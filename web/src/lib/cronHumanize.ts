export const SCHEDULE_PRESETS = [
  { label: "Manual only (no schedule)", value: "" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Daily at 02:00", value: "0 2 * * *" },
  { label: "Weekly, Sunday 03:00", value: "0 3 * * 0" },
  { label: "Custom cron…", value: "custom" },
];

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(n: string) {
  return n.padStart(2, "0");
}

/**
 * Turns a 5-field cron expression into a plain-language sentence. Falls back
 * to the raw expression for anything more complex than the common shapes
 * below (comma lists, ranges, day-of-month rules, etc.).
 */
export function humanizeCron(cron: string): string {
  if (!cron.trim()) return "Manual only";

  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  if (preset) return preset.label.replace(/\s*\(no schedule\)$/, "");

  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = fields;

  if (dom === "*" && mon === "*") {
    let everyMin = min.match(/^\*\/(\d+)$/);
    if (everyMin && hour === "*" && dow === "*") {
      return `Every ${everyMin[1]} minutes`;
    }
    let everyHour = hour.match(/^\*\/(\d+)$/);
    if (min === "0" && everyHour && dow === "*") {
      return `Every ${everyHour[1]} hours`;
    }
    if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hour)) {
      const time = `${pad(hour)}:${pad(min)}`;
      if (dow === "*") return `Daily at ${time}`;
      if (/^\d$/.test(dow)) {
        const day = DAYS[Number(dow) % 7];
        return `Weekly, ${day} at ${time}`;
      }
    }
  }

  return cron;
}
