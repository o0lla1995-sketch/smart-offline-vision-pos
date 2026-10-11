/**
 * Global tunables for the vision pipeline and the POS behaviour.
 */
import type {UnitKind} from './types';

/** Required input resolution of the bundled EfficientNet-B0
 *  embedder (v10 — round-16 #4). */
export const MODEL_INPUT_SIZE = 224;

/**
 * Pixel normalization for the v10 model. The Keras EfficientNet-B0
 * feature extractor INCLUDES its own rescaling layer, so it expects
 * RAW [0, 255] pixel values — the JS pipeline passes them through
 * unchanged: value = (pixel - 0) / 1
 */
export const NORM_MEAN = 0;
export const NORM_STD = 1;

/**
 * v10 (round-16 #4): the embedding-model GENERATION. Every stored /
 * backed-up fingerprint belongs to exactly one generation; when the
 * bundled model changes (v1 = MobileNetV3-Small, v2 = EfficientNet-B0)
 * old vectors live in a different feature space and are wiped once on
 * first load (and skipped on restore).
 */
export const EMBEDDING_MODEL_VERSION = 2;

/**
 * v10 multi-product window set (round-16 #4): one photo is probed
 * through a cascade — a full-frame FIT probe first (fast single-
 * product path), then a center window + a 3×3 grid of local windows
 * that find and read SEVERAL products in the same photo.
 */
export const VISION_WINDOW_CENTER = 0.85;
export const VISION_WINDOW_GRID = 0.55;
export const VISION_GRID_POSITIONS = [0.24, 0.5, 0.76] as const;
/** Two windows of the SAME product count as separate units only
 *  when they barely overlap (IoU below this) AND both are clearly
 *  confident — guards against one big item spanning the frame. */
export const VISION_UNIT_IOU = 0.25;
/** Extra confidence required before a same-product duplicate unit
 *  is counted (base threshold + this). */
export const VISION_UNIT_EXTRA_MARGIN = 0.04;
/** Max units of one product a single photo may add. */
export const VISION_MAX_UNITS_PER_PRODUCT = 4;
/** The FIT probe short-circuits (single fast add, no grid pass) only
 *  this far ABOVE the merchant's match threshold. */
export const VISION_FAST_PATH_EXTRA = 0.05;

/**
 * Default cosine similarity threshold.
 * v8.1: 0.82 → 0.78 — 0.82 was too strict for real-world lighting/angle
 * drift at the checkout counter; confident auto-adds rarely fired and
 * the merchant had to pick manually every time. 0.78 + the new
 * Settings slider (50–95%) gives direct control.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.78;

/** v9.1 (round-14 #2): ambiguity margin — the best product only
 *  auto-adds when the runner-up is at least this far BEHIND it.
 *  Two lookalike products scoring 0.84 vs 0.83 is a coin flip: the
 *  merchant gets the candidate strip instead of a silent wrong add
 *  (the "distinguish products by fine details" guarantee). */
export const VISION_AMBIGUITY_MARGIN = 0.035;

/** v9.1 (round-14 #6): internal EAN-13 barcodes the app generates
 *  for products without a manufacturer code — the in-store range
 *  (prefix 20…) is reserved by the EAN standard for store use, so
 *  every external scanner reads them as valid EAN-13 codes. */
export const INTERNAL_EAN13_PREFIX = '20';

/** v9.1: barcode height in dots for printed product labels. */
export const LABEL_BARCODE_HEIGHT_DOTS = 72;

/** Minimum time between two auto-adds of the SAME product (ms).
 *  v8.2: 1500 → 3500 — the ambient visual auto-capture keeps seeing
 *  the same product while it sits in front of the lens; a 3.5s
 *  window prevents runaway re-adds while "hold it a moment longer"
 *  still buys a second unit. A deliberate MANUAL shutter press
 *  always adds instantly (bypasses the window). */
export const DEFAULT_RECOGNITION_COOLDOWN_MS = 3500;

/** Scanner engine selected by the merchant from Settings. */
export type ScannerMode = 'barcode' | 'visual' | 'both';

/**
 * Pause between auto-scan cycles in the POS camera sheet (ms).
 * v6: 900 → 2000 ms — on budget hardware a capture + decode +
 * inference cycle takes ~1s, so 900ms meant near back-to-back
 * captures that stress cheap camera HALs. The loop already skips
 * while busy; this keeps the cadence genuinely calm.
 */
export const AUTO_SCAN_INTERVAL_MS = 2000;

/** Hard timeout around every native camera call — a hung camera can
 *  never freeze the scan flow again (v3's fatal freeze). */
export const CAPTURE_TIMEOUT_MS = 7000;

/** Barcode re-scan guard: same code ignored for this long (ms). */
export const BARCODE_DEDUPE_MS = 1600;

/** Default base unit name used when a product has no unit rows. */
export const BASE_UNIT_NAME = 'قطعة';

/** v8.3 (round-12 #4): base unit for WEIGHT-sold products — the kilo.
 *  Prices are per kilo, stock is tracked in fractional kilograms. */
export const WEIGHT_UNIT_NAME = 'كغ';

/** v8.3: quick weights in the POS weight pad (kg) with Arabic labels —
 *  the regional counter staples: وقية (250 g) and نصف كيلو (500 g)
 *  get one tap, no typing. */
export const QUICK_WEIGHTS: {kg: number; label: string}[] = [
  {kg: 0.25, label: 'وقية'},
  {kg: 0.5, label: 'نصف كغ'},
  {kg: 0.75, label: '٣ أرباع'},
  {kg: 1, label: 'كيلو'},
  {kg: 1.5, label: 'كغ ونص'},
  {kg: 2, label: '٢ كغ'},
];

/** v8.3: rounding precision for weight quantities (3 decimals = 1 g). */
export const WEIGHT_QTY_DECIMALS = 3;

/** v8.3: floating-point slack when comparing fractional stock (1 g). */
export const QTY_EPSILON = 0.001;

/** v9.2 (round-15 #3): units seeded on first run — now a FULL
 *  catalog with its TYPE (kind). The merchant asked for ALL the
 *  units with their types, with weight clearly distinguished from
 *  piece — so weight products get weight units (كيلو، غرام، وقية،
 *  رطل، أونصة…), piece products get packaging units (كرتونة، علبة،
 *  كيس، دستة…), and volume/length units are there too. */
export const DEFAULT_UNITS: {name: string; short: string; kind: UnitKind}[] = [
  // ── قطعة (packaging / count) ──
  {name: 'قطعة', short: 'ق', kind: 'piece'},
  {name: 'كرتونة', short: 'كرت', kind: 'piece'},
  {name: 'علبة', short: 'علب', kind: 'piece'},
  {name: 'كيس', short: 'كيس', kind: 'piece'},
  {name: 'دزينة', short: 'دز', kind: 'piece'},
  {name: 'زجاجة', short: 'زج', kind: 'piece'},
  {name: 'عبوة', short: 'عبوة', kind: 'piece'},
  {name: 'حزمة', short: 'حزمة', kind: 'piece'},
  {name: 'صندوق', short: 'صندوق', kind: 'piece'},
  {name: 'شوال', short: 'شوال', kind: 'piece'},
  {name: 'صينية', short: 'صينية', kind: 'piece'},
  {name: 'طبق', short: 'طبق', kind: 'piece'},
  // ── وزن ──
  {name: 'كيلوغرام', short: 'كغ', kind: 'weight'},
  {name: 'غرام', short: 'غ', kind: 'weight'},
  {name: 'وقية', short: 'وقية', kind: 'weight'},
  {name: 'نصف كيلو', short: 'نصف', kind: 'weight'},
  {name: 'رطل', short: 'رطل', kind: 'weight'},
  {name: 'أونصة', short: 'أونصة', kind: 'weight'},
  // ── حجم ──
  {name: 'لتر', short: 'ل', kind: 'volume'},
  {name: 'مليلتر', short: 'مل', kind: 'volume'},
  {name: 'جالون', short: 'جالون', kind: 'volume'},
  // ── طول ──
  {name: 'متر', short: 'م', kind: 'length'},
  {name: 'سنتيمتر', short: 'سم', kind: 'length'},
];

/** v9.2 (round-15 #3): Arabic labels for the unit kinds. */
export const UNIT_KIND_LABELS: Record<UnitKind, string> = {
  piece: 'قطعة',
  weight: 'وزن',
  volume: 'حجم',
  length: 'طول',
};

/** v9.2 (round-15 #3): the FULL standard catalog used by the v5
 *  migration to top up existing installs (name → kind). */
export const STANDARD_UNITS_V5: {name: string; short: string; kind: UnitKind}[] =
  DEFAULT_UNITS;

/** Embedding JSON serialization precision (float decimals). */
export const EMBEDDING_DECIMALS = 6;

/** Enrollment angles (3 vectors per product, per spec). */
export const ANGLE_LABELS = ['front', 'back', 'side'] as const;

export const ANGLE_LABELS_AR: Record<string, string> = {
  front: 'أمامية',
  back: 'خلفية',
  side: 'جانبية',
};

/** Default low-stock alert threshold when a product has no override. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;
/** v32 (round-40 #3): نافذة التنبيه قبل انتهاء الصلاحية (بالأيام). */
export const DEFAULT_EXPIRY_ALERT_DAYS = 14;

/** Receipt paper widths in characters (default font). */
export const RECEIPT_WIDTH_58 = 32;
export const RECEIPT_WIDTH_80 = 48;

/** Default ESC/POS codepage: 47 = Windows-1256 Arabic. */
export const CODEPAGE_CP1256 = 47;
export const CODEPAGE_CP864 = 45;
export const CODEPAGE_ASCII = 0;

/** Currency suffix used across the app. */
export const CURRENCY = '₪';

/** SQLite file name. */
export const DB_NAME = 'sela.db';

/** Schema version — bump + add a migration branch when changing DDL. */
export const DB_SCHEMA_VERSION = 8;

/** App display name (Latin, per merchant request) used everywhere. */
export const APP_NAME = 'sela';
export const APP_NAME_AR = 'سيلا';

/**
 * App version — shown on the Home dashboard badge, Settings → About
 * and in the release APK file name. Keep in sync with
 * android/app/build.gradle versionName/versionCode.
 */
export const APP_VERSION = '45.0.0';
/** Android versionCode (build number) — bump on EVERY release. */
export const APP_BUILD_CODE = 53;
/** Human-readable version with build number, e.g. "6.0.0 (7)". */
export const APP_VERSION_LABEL = `${APP_VERSION} (${APP_BUILD_CODE})`;

// ─────────────────────────────────────────────────────────────
// Subscription / licensing
// ─────────────────────────────────────────────────────────────

/** Default license-server base URL (owner's Coolify deployment).
 *  Merchants can override it in the activation screen if the
 *  management moves the server. */
export const LICENSE_SERVER_URL =
  'http://8jz9a3yyhn3eltmwqgnchn29.130.61.171.201.sslip.io';

/** Ed25519 PUBLIC key (hex) of the license server — licenses are
 *  signed server-side and verified on-device; the private key never
 *  leaves the server. Rotating the pair requires an app update. */
export const LICENSE_PUBLIC_KEY_HEX =
  '6ee513c1b7f0b057d970c6c2f4b33e5d026bc4c798b5a0b8bb72818d3197d103';

/** Offline grace: hours an activated POS keeps working with no
 *  server contact (POS must survive offline trading days). */
export const LICENSE_GRACE_SOFT_HOURS = 72;

/** After this many offline hours the app locks until it reaches
 *  the server once (anti-crack: no eternal offline use). */
export const LICENSE_GRACE_HARD_HOURS = 240;

/** Wall-clock rollback beyond this (ms) counts as a tamper strike. */
export const LICENSE_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;

/** Management contact shown on the activation + subscription
 *  screens (server config overrides these when reachable). Any
 *  channel left empty here (or on the server) is hidden in the UI. */
export const LICENSE_CONTACT_FALLBACK = {
  phone: '+972 59 000 0000',
  whatsapp: '+972 59 000 0000',
  telegram: '',
  email: 'abdalasela@gmail.com',
  note: 'لشراء أو تجديد الاشتراك تواصل مع الإدارة عبر أحد قنوات التواصل',
};
