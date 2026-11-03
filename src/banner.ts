// The fastfetch-style status block: a computer inside a swirling nebula on
// the left, key/value facts on the right. Pure: the same facts always draw
// the same lines, and color is a flag, so plain output is the colored output
// with the escape codes removed.

export type Fact = { readonly key: string; readonly value: string; readonly strong?: boolean };

const W = 42;
const H = 15;
const GAP = "  ";

const COMPUTER = [
  "╭──────────────────╮",
  "│ ▓▒░ agent ░▒▓    │",
  "│ >_ mailbox_      │",
  "│ * signed, sealed │",
  "╰────────┬─────────╯",
  "      ───┴───       ",
];
// Per screen row, the color of its text; the frame is light grey.
const SCREEN_COLORS = [252, 213, 48, 117, 252, 252];
// Purple through pink to blue and cyan, around the swirl.
const NEBULA = [55, 56, 93, 129, 165, 201, 207, 213, 177, 141, 105, 69, 75, 81, 87, 51];
const BRIGHT_STAR = 230;
const DIM_STAR = 245;
const KEY = 141;

type Cell = { readonly char: string; readonly color: number | null };

// A fixed hash, not Math.random: the art is identical on every run.
const hash = (x: number, y: number) => (Math.imul(x + 11, 73856093) ^ Math.imul(y + 7, 19349663)) >>> 0;

function nebulaCell(x: number, y: number): Cell {
  const dx = (x - W / 2) / 2.1; // terminal cells are about twice as tall as wide
  const dy = y - H / 2;
  const r = Math.hypot(dx, dy);
  const a = Math.atan2(dy, dx);
  const swirl = Math.sin(2 * a - r * 0.7) * Math.max(0, 1 - r / 13);
  const phase = ((a + Math.PI) / (2 * Math.PI) + r / 9) % 1;
  const color = NEBULA[Math.floor(phase * NEBULA.length)]!;
  if (swirl > 0.62) return { char: "▓", color };
  if (swirl > 0.42) return { char: "▒", color };
  if (swirl > 0.24) return { char: "░", color };
  const h = hash(x, y);
  if (h % 7 !== 0) return { char: " ", color: null };
  const star = ".·*+˚"[h % 5]!;
  return { char: star, color: star === "*" || star === "+" ? BRIGHT_STAR : DIM_STAR };
}

function logo(): readonly (readonly Cell[])[] {
  const top = Math.floor((H - COMPUTER.length) / 2);
  const left = Math.floor((W - COMPUTER[0]!.length) / 2);
  return Array.from({ length: H }, (_, y) =>
    Array.from({ length: W }, (_, x) => {
      const row = y - top;
      const piece = COMPUTER[row]?.[x - left];
      // The monitor is opaque; the stand's blank corners let the nebula show through.
      const solid = piece !== undefined && (row < 5 || piece !== " ");
      return solid ? { char: piece, color: /[─│╭╮╰╯┬┴]/.test(piece) ? 252 : SCREEN_COLORS[row]! } : nebulaCell(x, y);
    }),
  );
}

const paint = (text: string, color: number | null, on: boolean) => (on && color !== null && text.trim() !== "" ? `\x1b[38;5;${color}m${text}\x1b[0m` : text);
const bold = (text: string, on: boolean) => (on ? `\x1b[1m${text}\x1b[0m` : text);

function panel(title: string, facts: readonly Fact[], color: boolean): readonly string[] {
  const width = Math.max(...facts.map((f) => f.key.length));
  return [
    bold(paint(title, 213, color), color),
    paint("─".repeat(title.length), 245, color),
    ...facts.map((f) => `${paint(f.key.padEnd(width), KEY, color)}  ${f.strong === true ? bold(f.value, color) : f.value}`),
    "",
    NEBULA.filter((_, i) => i % 2 === 0)
      .map((n) => paint("███", n, color))
      .join(""),
  ];
}

export function renderStatus(title: string, facts: readonly Fact[], color: boolean): readonly string[] {
  const art = logo().map((row) => row.map((cell) => paint(cell.char, cell.color, color)).join(""));
  const side = panel(title, facts, color);
  // The panel starts one row down, beside the top of the swirl, as fastfetch's does.
  const height = Math.max(art.length, side.length + 1);
  return Array.from({ length: height }, (_, i) => {
    const left = art[i] ?? " ".repeat(W);
    const right = side[i - 1] ?? "";
    return right === "" ? left : `${left}${GAP}${right}`;
  });
}

/** Text styles for the rest of the CLI's output, all no-ops when color is off. */
export function styles(color: boolean) {
  return {
    bold: (text: string) => bold(text, color),
    dim: (text: string) => (color ? `\x1b[2m${text}\x1b[0m` : text),
    /** A command to type: bold cyan, so it stands out from the prose around it. */
    cmd: (text: string) => bold(paint(text, 87, color), color),
    accent: (text: string) => bold(paint(text, 213, color), color),
  };
}
