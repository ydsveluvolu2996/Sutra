"use client";

import { useEffect, useRef } from "react";

import { THEME_CHANGED_EVENT } from "./theme-toggle";
import styles from "./landing-hero-cinematic.module.css";

/* ==================================================================== *
 * LandingHeroCinematic — a full-bleed cinematic graphic band for the
 * public marketing page.
 *
 * THE MOTIF
 * A vast field of small glowing cyan dots arranged on a CURVED surface —
 * like looking across the inside of a huge shallow bowl. Rows of dots arc
 * horizontally (never straight) and converge toward a horizon band across
 * the middle. The field masses across the top and the bottom and leaves
 * the middle dark and calm, so the centred headline sits cleanly.
 *
 * The defining quality is bokeh depth of field:
 *   - near the horizon: tiny (~1px), sharp, dim, densely packed
 *   - toward the top edge and especially the bottom foreground:
 *     progressively larger, heavily blurred into soft glowing discs, each
 *     trailing a long, very faint smear DOWNWARD. The near field is dense
 *     enough that those trails overlap into a continuous vertical curtain —
 *     high density at low per-dot alpha, accumulated through `lighter`, is
 *     what makes it read as a lit surface rather than scattered dots.
 *
 * `ctx.filter = "blur()"` is unreliable across engines, so every dot is
 * drawn as a real radial-gradient disc. The discs are pre-rendered once
 * per resize into a small sprite atlas (tint x softness) and blitted with
 * drawImage — identical output to building a gradient per dot, but fast
 * enough for ~1.5k dots a frame.
 *
 * The layout is computed once per resize; the loop only advances a slow
 * per-dot brightness shimmer and a very slow whole-field drift.
 *
 * Theme: the active theme lives on document.documentElement as
 * data-theme="light" | "dark" (see theme-toggle.tsx) and flips are
 * announced on window via THEME_CHANGED_EVENT. The band stays a dark lit
 * stage in both themes — in light theme the CSS module frames it as a
 * deliberate inset panel — and the field just re-tints slightly cooler
 * and brighter so it holds up against the pale surround.
 *
 * Motion: honours prefers-reduced-motion by painting exactly one static
 * frame and never starting the rAF loop. The loop, the ResizeObserver and
 * every listener are torn down on unmount.
 * ==================================================================== */

/**
 * A dot's fixed identity. Its DEPTH is not stored here — depth lives on the
 * row that owns it (`Row.u`) and advances continuously, so the whole field
 * flows through the tunnel without re-laying anything out.
 */
type Dot = {
  /** Horizontal position, -1..1 across the band (constant). */
  xn: number;
  /** Small fixed pixel jitter so rows never look mechanical. */
  jx: number;
  jy: number;
  tint: number;
  /** Baseline brightness multiplier. */
  seedA: number;
  /** Depth past which this dot drops out, thinning the near foreground. */
  cull: number;
  phase: number;
  speed: number;
};

/** A row of dots at one depth. `u` runs 0 (horizon) -> 1 (outer edge). */
type Row = {
  u: number;
  band: number;
  dots: Dot[];
};

type Palette = {
  /** Pale, desaturated blue-white dot tints — light, not coloured plastic. */
  tints: string[];
  /** Near-white core every disc is lit from. */
  core: string;
  /** Saturated cyan, used ONLY for the thin horizon glow. */
  horizon: string;
  alpha: number;
};

const DARK: Palette = {
  // #bae6fd, #7dd3fc, #a5c8e8 (the cooler one carries depth variance)
  tints: ["186,230,253", "125,211,252", "165,200,232"],
  core: "224,242,254", // #e0f2fe
  horizon: "34,211,238", // #22d3ee — the one saturated accent left in the band
  alpha: 1,
};

const LIGHT: Palette = {
  tints: ["205,238,255", "150,219,253", "185,213,238"],
  core: "236,248,255",
  horizon: "34,211,238",
  alpha: 1.08,
};

/** Tint mix: mostly the two pale blues, a fifth of the cooler depth tint. */
const TINT_WEIGHTS = [0.45, 0.8, 1];

/**
 * The two dot masses. `dir` -1 is the ceiling, +1 the floor; the floor is
 * the nearer, deeper mass so its foreground discs run larger.
 */
const BANDS = [
  { dir: -1, rows: 14, reach: 0.29, gap: 0.14, maxR: 8, curve: 0.13 },
  { dir: 1, rows: 16, reach: 0.34, gap: 0.14, maxR: 13, curve: 0.16 },
];

const SOFT_BUCKETS = 7;
const SPRITE_PX = 128;
const TAIL_W = 48;
const TAIL_H = 256;

/**
 * The golden ratio's fractional part. Stepping a fractional accumulator by this
 * value is the classic low-discrepancy sequence: by the three-distance theorem
 * the first N terms are always as evenly spread over [0,1) as N points can be,
 * and — critically — that stays true for EVERY prefix. So thresholding on it
 * (see `cull`) keeps an evenly spaced subset at any density, which is exactly
 * what plain `Math.random()` cannot promise.
 */
const PHI = 0.618033988749895;
const frac = (x: number) => x - Math.floor(x);

/** The whole field is seeded from one constant, so a resize rebuilds the SAME
 *  field rather than reshuffling it under the viewer. */
const FIELD_SEED = 0x5eed1f;

/** mulberry32 — small, fast, deterministic. No dependency. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A pre-rendered glowing disc, lit from a near-white core out to a pale
 * blue-white rim. `softness` in [0,1]: 0 is a crisp point, 1 is a wide
 * bokeh disc with a flat-ish core and a long falloff.
 */
function makeDisc(rgb: string, core: string, softness: number): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = SPRITE_PX;
  sprite.height = SPRITE_PX;
  const c = sprite.getContext("2d");
  if (!c) return sprite;
  const mid = SPRITE_PX / 2;
  const g = c.createRadialGradient(mid, mid, 0, mid, mid, mid);
  // Crisp dots keep a hard core; soft dots spread the core outward and
  // hold a faint rim, which is what reads as out-of-focus bokeh.
  const stop = 0.16 + softness * 0.4;
  g.addColorStop(0, `rgba(${core},1)`);
  g.addColorStop(stop * 0.55, `rgba(${core},${0.96 - softness * 0.12})`);
  g.addColorStop(stop, `rgba(${rgb},${0.9 - softness * 0.16})`);
  g.addColorStop(Math.min(0.94, stop + 0.2 + softness * 0.16), `rgba(${rgb},${0.32 - softness * 0.09})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g;
  c.beginPath();
  c.arc(mid, mid, mid, 0, Math.PI * 2);
  c.fill();
  return sprite;
}

/**
 * The long, very soft light trail smeared DOWNWARD from a near-field disc.
 * This is what turns discrete dots into a vertical "curtain": adjacent trails
 * overlap and merge into a continuous luminous texture across the lower band.
 * It is deliberately faint — a long gradient, never a stretched blob — and it
 * is pre-rendered ONCE per tint per resize, then blitted at whatever
 * width/height a dot needs, so a 4x-tall trail still costs one drawImage.
 *
 * Built as a vertical fade, then masked horizontally with `destination-in` so
 * both side edges fall off softly instead of showing a hard column.
 */
function makeTail(rgb: string): HTMLCanvasElement {
  const sprite = document.createElement("canvas");
  sprite.width = TAIL_W;
  sprite.height = TAIL_H;
  const c = sprite.getContext("2d");
  if (!c) return sprite;

  const vg = c.createLinearGradient(0, 0, 0, TAIL_H);
  vg.addColorStop(0, `rgba(${rgb},0)`);
  vg.addColorStop(0.04, `rgba(${rgb},1)`);
  vg.addColorStop(0.22, `rgba(${rgb},0.52)`);
  vg.addColorStop(0.48, `rgba(${rgb},0.24)`);
  vg.addColorStop(0.76, `rgba(${rgb},0.08)`);
  vg.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = vg;
  c.fillRect(0, 0, TAIL_W, TAIL_H);

  c.globalCompositeOperation = "destination-in";
  const hg = c.createLinearGradient(0, 0, TAIL_W, 0);
  hg.addColorStop(0, "rgba(0,0,0,0)");
  hg.addColorStop(0.18, "rgba(0,0,0,0.14)");
  hg.addColorStop(0.34, "rgba(0,0,0,0.66)");
  hg.addColorStop(0.5, "rgba(0,0,0,1)");
  hg.addColorStop(0.66, "rgba(0,0,0,0.66)");
  hg.addColorStop(0.82, "rgba(0,0,0,0.14)");
  hg.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = hg;
  c.fillRect(0, 0, TAIL_W, TAIL_H);
  return sprite;
}

export type LandingHeroCinematicProps = {
  /** Extra class on the outer band, e.g. to control vertical rhythm. */
  className?: string;
  /** Optional id, useful as an in-page anchor target. */
  id?: string;
  /** The small, light line above the display line. */
  lead?: string;
  /** The very large cyan display line. */
  display?: string;
  /** One supporting sentence under the display line. */
  subhead?: string;
  /** 0-4 short capability chips. */
  chips?: readonly string[];
  /** Fragment id the bottom scroll cue jumps to. */
  cueTarget?: string;
};

const DEFAULT_CHIPS = [
  "Live AWS CMDB",
  "Reachability-proven findings",
  "FinOps cost & waste",
  "Compliance evidence",
] as const;

export default function LandingHeroCinematic({
  className,
  id,
  lead = "Every account, every cluster, every finding —",
  display = "woven together.",
  subhead =
    "An always-current AWS CMDB under EKS-first security: risk proven reachable, cost and waste priced per account, compliance readiness evidenced. Every result cited, every query tenant-scoped.",
  chips = DEFAULT_CHIPS,
  cueTarget = "lz-hero",
}: LandingHeroCinematicProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let W = 0;
    let H = 0;
    let DPR = 1;
    let horizon = 0;
    let raf = 0;
    let onScreen = true;
    let t = 0;
    let last = 0;
    let sizeScale = 1;
    let pal: Palette = DARK;
    let rows: Row[] = [];
    /** sprites[tint][softness bucket] */
    let sprites: HTMLCanvasElement[][] = [];
    /** tails[tint] — the long soft downward trail, one per tint. */
    let tails: HTMLCanvasElement[] = [];
    /**
     * Seconds for a row to travel from the horizon to the near edge.
     *
     * Deliberately very slow. The reference field is essentially
     * indistinguishable over one second and only clearly shifted over two to
     * three, so the perceptible life comes mostly from the per-dot twinkle and
     * a slight lateral drift — not from depth translation you can watch
     * marching. A ~56s traverse puts depth well below the noticing threshold
     * on a one-second glance.
     */
    const TRAVERSE_S = 56;

    const readPalette = () =>
      document.documentElement.dataset.theme === "light" ? LIGHT : DARK;

    const buildSprites = () => {
      sprites = pal.tints.map((rgb) =>
        Array.from({ length: SOFT_BUCKETS }, (_, i) =>
          makeDisc(rgb, pal.core, i / (SOFT_BUCKETS - 1))
        )
      );
      tails = pal.tints.map((rgb) => makeTail(rgb));
    };

    /**
     * Build the two dot masses of the tunnel: an upper band descending from
     * the top edge and a lower band rising from the bottom, both receding
     * toward a horizon in the vertical middle, leaving a calm dark middle
     * third for the type.
     *
     * Only each dot's IDENTITY is baked here (its lane, jitter, tint). Depth
     * lives on the row and advances every frame, so the field flows without
     * ever being rebuilt. Rows are seeded at even depths, so wrapping a row
     * back to the horizon preserves the spacing.
     *
     * Depth runs from the MIDDLE OUTWARD: u=0 is the horizon (tiny, sharp,
     * dim, dense) and u=1 is the extreme top/bottom edge (large, heavily
     * blurred, bright, sparse).
     */
    const buildField = () => {
      const cssW = W / DPR;
      // Every row is seeded at horizon density; the per-dot `cull` thins the
      // field out as a row travels forward, so the near edge holds only a
      // few big discs.
      // Density is the look: the near field only merges into a continuous
      // luminous surface if there are enough discs down there to overlap. The
      // cost of that density is paid back by keeping per-dot alpha LOW (see
      // `depthA` in paint) rather than by thinning the field out.
      //
      // Phones get a smaller field because the band is smaller, not because
      // the texture is cheapened — the divisor is the same at every width.
      const cols = Math.max(8, Math.min(104, Math.round((cssW * 1.22) / 12.5)));
      const next: Row[] = [];

      // One seeded stream for every appearance value. Same field on every
      // resize, so the composition never reshuffles under the viewer.
      const rnd = makeRng(FIELD_SEED);
      let rowIndex = 0;

      for (let band = 0; band < BANDS.length; band++) {
        const rowCount = BANDS[band].rows;
        for (let i = 0; i < rowCount; i++) {
          const dots: Dot[] = [];
          // Row phase from the SAME low-discrepancy sequence, so consecutive
          // rows interleave smoothly instead of alternating between two
          // positions (which is what let vertical clusters line up).
          const stagger = frac(rowIndex * PHI);
          const cullPhase = frac(rowIndex * PHI * 3 + 0.37);
          rowIndex++;
          for (let j = 0; j <= cols; j++) {
            const xn = -1 + (2 * (j + stagger)) / cols;
            if (xn < -1.02 || xn > 1.02) continue;
            const roll = rnd();
            const tint = roll < TINT_WEIGHTS[0] ? 0 : roll < TINT_WEIGHTS[1] ? 1 : 2;
            dots.push({
              xn,
              // Jitter breaks the mechanical grid but is capped WELL below one
              // lane pitch, so a dot can never cross into its neighbour's
              // stratum and bunch up. This is a jittered grid, not scatter.
              jx: (rnd() - 0.5) * Math.min(7 * DPR, ((1.22 * W) / cols) * 0.5),
              jy: (rnd() - 0.5) * H * 0.01,
              tint,
              seedA: 0.66 + rnd() * 0.34,
              // NOT random: a golden-ratio walk over the lane index. Thinning
              // by `cull > threshold` therefore keeps a maximally evenly spaced
              // subset of the row at ANY density — no bald patches, no clumps.
              cull: frac((j + 1) * PHI + cullPhase),
              phase: rnd() * Math.PI * 2,
              // Twinkle rate, rad/s. Tuned against the reference's measured
              // cadence: one second must read as essentially still, two to
              // three seconds as clearly shifted. A 0.07-0.25 rad/s spread puts
              // a one-second phase step well under a tenth of a cycle.
              speed: 0.07 + rnd() * 0.18,
            });
          }
          next.push({ u: (i + 0.5) / rowCount, band, dots });
        }
      }
      rows = next;
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      // Every dot is a soft, blurred radial disc — there is no hard edge for
      // the extra backing pixels to sharpen — so phones get a 1.5x cap
      // instead of 2x: ~44% less fill per frame on a battery-powered device,
      // with no visible difference in the field. Desktop keeps 2x.
      const maxDpr = window.innerWidth <= 560 ? 1.5 : 2;
      DPR = Math.min(maxDpr, window.devicePixelRatio || 1);
      W = canvas.width = Math.max(1, Math.round(rect.width * DPR));
      H = canvas.height = Math.max(1, Math.round(rect.height * DPR));
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      horizon = H * 0.5;
      // Bokeh discs are sized against the band's own width, so a phone gets
      // a proportionally scaled field rather than a few giant blobs.
      sizeScale = Math.max(0.5, Math.min(1, W / DPR / 1180));
      pal = readPalette();
      buildSprites();
      buildField();
    };

    /** A subtle horizontal glow pooled along the horizon band. */
    const drawHorizonGlow = () => {
      const h = Math.max(20 * DPR, H * 0.2);
      const g = ctx.createLinearGradient(0, horizon - h, 0, horizon + h);
      g.addColorStop(0, `rgba(${pal.horizon},0)`);
      g.addColorStop(0.5, `rgba(${pal.horizon},${0.12 * pal.alpha})`);
      g.addColorStop(1, `rgba(${pal.horizon},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, horizon - h, W, h * 2);

      const rx = W * 0.42;
      const ry = h * 0.9;
      ctx.save();
      ctx.translate(W / 2, horizon);
      ctx.scale(1, ry / rx);
      const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      rg.addColorStop(0, `rgba(${pal.horizon},${0.2 * pal.alpha})`);
      rg.addColorStop(0.42, `rgba(${pal.horizon},${0.07 * pal.alpha})`);
      rg.addColorStop(1, `rgba(${pal.horizon},0)`);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const paint = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      drawHorizonGlow();

      // Very slow whole-field drift, so the tunnel breathes. Deliberately a
      // larger lateral amplitude than before: with depth advance halved, the
      // drift and the twinkle are what the eye reads as "alive".
      const driftX = Math.sin(t * 0.055) * 15 * DPR;
      const driftY = Math.cos(t * 0.041) * 6 * DPR;
      const still = motion.matches;

      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        const band = BANDS[row.band];
        const u = row.u;
        // Ease depth so rows bunch up toward the horizon (foreshortening).
        const e = Math.pow(u, 1.6);
        const baseY = horizon + band.dir * (H * band.gap + e * H * band.reach);
        // The row's ENDS bend back toward the horizon; its centre stays on
        // baseY — a gentle arc, so the mass reads as a curved surface.
        const arc = band.dir * H * band.curve * Math.pow(u, 1.25);
        const r = (1 + e * e * band.maxR * sizeScale) * DPR;
        const w = r * 2;
        // Wet-floor elongation: the disc is stretched DOWNWARD, 1.0 at the
        // horizon growing to ~1.78 at the near edge.
        const ratio = 1 + Math.pow(Math.min(1, e), 1.35) * 0.72;
        const h = w * ratio;
        const soft = Math.min(SOFT_BUCKETS - 1, Math.round(Math.min(1, e) * (SOFT_BUCKETS - 1)));
        // Density high, alpha LOW. The near field is now dense enough to
        // overlap, so each disc contributes only a little and the luminance
        // accumulates through `lighter` compositing instead of arriving as a
        // handful of bright blobs.
        const depthA = 0.24 + e * 0.2;
        // Fade in off the horizon and out at the near edge so the wrap-around
        // never pops.
        const edgeFade = Math.min(1, u / 0.05) * Math.min(1, (1 - u) / 0.1);
        if (edgeFade <= 0.01) continue;
        // Only a light thinning toward the near edge (was 0.24 survival at the
        // very front, which is what kept the foreground reading as scattered
        // dots rather than a lit surface).
        const cullAt = 0.98 - 0.28 * u;
        // The long soft downward trail. Ramped LATE — nothing at the horizon,
        // reaching ~4.5x the disc width only in the near half — and drawn at a
        // fraction of the core's alpha so it stays a light trail.
        const tailK = Math.pow(Math.max(0, (e - 0.3) / 0.7), 1.45);
        const tailH = w * (0.9 + tailK * 3.9);
        const tailW = w * 0.66;
        const drawTail = tailK > 0.03;

        for (let i = 0; i < row.dots.length; i++) {
          const d = row.dots[i];
          if (d.cull > cullAt) continue;
          const x = W / 2 + d.xn * (W * 0.61) + d.jx + driftX;
          const y = baseY - arc * d.xn * d.xn + d.jy + driftY;
          if (y < -H * 0.12 || y > H * 1.12) continue;
          // A very slow, independent per-dot shimmer; frozen (but still
          // varied) when the user asked for reduced motion.
          // Deeper amplitude than before: with depth advance halved, the
          // twinkle carries most of the perceptible life in the field.
          const shimmer = 0.58 + 0.42 * Math.sin((still ? 0 : t * d.speed) + d.phase);
          const a = Math.min(1, depthA * d.seedA * shimmer * edgeFade * pal.alpha);
          if (drawTail) {
            // Beneath the core, much fainter, 3-5x as long: this is the smear
            // that merges with its neighbours into the vertical curtain.
            ctx.globalAlpha = a * (0.2 + tailK * 0.16);
            ctx.drawImage(tails[d.tint], x - tailW / 2, y - r * 0.2, tailW, tailH);
          }
          ctx.globalAlpha = a;
          ctx.drawImage(sprites[d.tint][soft], x - r, y - r, w, h);
        }
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    /** Advance the ambient flow: every row marches toward the near edge. */
    const advance = (dt: number) => {
      t += dt;
      const du = dt / TRAVERSE_S;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        row.u += du;
        while (row.u >= 1) row.u -= 1;
      }
    };

    const loop = (ts: number) => {
      // Clamp dt so a backgrounded tab does not jump the field forward.
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
      last = ts;
      advance(dt);
      paint();
      raf = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const start = () => {
      stop();
      if (motion.matches) {
        // Reduced motion: exactly one static frame, no flow, no shimmer.
        paint();
        return;
      }
      // Only flow while the band is actually on screen.
      if (!onScreen) {
        paint();
        return;
      }
      last = 0;
      raf = requestAnimationFrame(loop);
    };

    resize();
    start();

    // Setting canvas.width in resize() CLEARS the bitmap, so the frame has to
    // be re-drawn unconditionally — not just under reduced motion. When the
    // IntersectionObserver perf gate has the loop paused (band off screen) the
    // old code left the canvas blank until the band happened to scroll back
    // into view; a rotate-while-scrolled-away could show an empty stage.
    const onResize = () => {
      resize();
      paint();
    };
    const onTheme = () => {
      pal = readPalette();
      buildSprites();
      paint();
    };
    const onMotion = () => {
      start();
    };

    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    // Purely a perf gate: pause the loop whenever the band is off screen.
    const io = new IntersectionObserver(
      (entries) => {
        const next = entries[entries.length - 1].isIntersecting;
        if (next === onScreen) return;
        onScreen = next;
        if (onScreen) start();
        else stop();
      },
      { rootMargin: "120px 0px" }
    );
    io.observe(host);
    window.addEventListener(THEME_CHANGED_EVENT, onTheme);
    window.addEventListener("storage", onTheme);
    motion.addEventListener("change", onMotion);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener(THEME_CHANGED_EVENT, onTheme);
      window.removeEventListener("storage", onTheme);
      motion.removeEventListener("change", onMotion);
    };
  }, []);

  return (
    <div className={className ? `${styles.band} ${className}` : styles.band} id={id} ref={hostRef}>
      <div className={styles.stage}>
        <div className={styles.ground} aria-hidden="true" />
        <div className={styles.nebula} aria-hidden="true" />
        <canvas className={styles.canvas} ref={canvasRef} aria-hidden="true" />
        <div className={styles.scrim} aria-hidden="true" />
        <div className={styles.vignette} aria-hidden="true" />

        <div className={styles.copy}>
          <h2 className={styles.head}>
            <span className={styles.lead}>{lead}</span>
            <span className={styles.display}>{display}</span>
          </h2>
          <p className={styles.sub}>{subhead}</p>
          {chips.length > 0 && (
            <ul className={styles.chips}>
              {chips.slice(0, 4).map((chip) => (
                <li className={styles.chip} key={chip}>
                  {chip}
                </li>
              ))}
            </ul>
          )}
        </div>

        <a className={styles.cue} href={`#${cueTarget}`} aria-label="Scroll to the platform overview">
          <span className={styles.cueMouse} aria-hidden="true" />
          <svg
            className={styles.cueChev}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
          <span className={styles.cueLabel}>Scroll</span>
        </a>
      </div>
    </div>
  );
}
