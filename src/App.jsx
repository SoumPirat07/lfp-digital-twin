import React, { useMemo, useState } from 'react';

/*
 * Battery Digital Twin — upgraded degradation engine
 *
 * Model philosophy:
 *  - Semi-empirical / physics-informed rather than claiming a first-principles electrochemical model.
 *  - Separate degradation states: LLI, LAM and resistance growth.
 *  - Calendar ageing follows Arrhenius + SOC stress + sqrt(time).
 *  - Cycle ageing is accumulated incrementally from EFC, DOD, mean SOC,
 *    temperature and charge/discharge C-rate.
 *  - Lithium-plating risk is charge-specific and strongly temperature/SOC dependent.
 *  - A smooth knee emerges from accelerating degradation rather than a fixed
 *    "chemistry knee EFC".
 *  - Telemetry REFINES the chemistry priors, not replace them: calibration is a
 *    bounded, shrinkage-regularized fit (see fitCalibrationToTelemetry) so a
 *    handful of noisy field points nudges the model instead of overriding it.
 *  - A daily simulation is used internally; the UI graph is decimated for readability.
 */

const DEFAULT_PRIORS = {
  LFP: {
    // Capacity-loss contributions at a nominal reference duty cycle.
    // Adjusted to align with modern prismatic cells (e.g., EVE LF230 SOH = 80% @ ~6000 cycles)
    calendarRefPctAt1yr: 0.70,
    cycleRefPctPer1000Efc: 2.5,
    lliShare: 0.68,
    lamShare: 0.32,

    // Stress exponents / sensitivities.
    calendarTimeExponent: 0.50,
    calendarEaKJ: 34,
    calendarSocExponent: 1.35,
    cycleDODExponent: 1.10,
    cycleCExponent: 0.55,
    cycleSocExponent: 0.55,

    // Plating risk.
    platingTempOnsetC: 15,
    platingSocOnset: 70,
    platingCOnset: 0.35,

    // Resistance.
    resistanceGrowthPctAt80Loss: 80,

    // Smooth knee: LFP stays flatter for longer, breaking downwards closer to 80-85%
    kneeStartSOH: 82,
    kneeStrength: 1.50,

    // Prior uncertainty used for confidence band.
    priorUncertaintyPct: 18
  },
  NMC: {
    calendarRefPctAt1yr: 1.20,
    cycleRefPctPer1000Efc: 8.5,
    lliShare: 0.74,
    lamShare: 0.26,

    calendarTimeExponent: 0.50,
    calendarEaKJ: 42,
    calendarSocExponent: 1.55,
    cycleDODExponent: 1.12,
    cycleCExponent: 0.62,
    cycleSocExponent: 0.70,

    platingTempOnsetC: 18,
    platingSocOnset: 65,
    platingCOnset: 0.30,

    resistanceGrowthPctAt80Loss: 105,

    kneeStartSOH: 88,
    kneeStrength: 1.20,

    priorUncertaintyPct: 20
  }
};

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const safeNum = (x, fallback = 0) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
};

const arrheniusFactor = (tempC, eaKJ) => {
  const T = clamp(tempC, -30, 80) + 273.15;
  const Tref = 298.15;
  const R = 8.314;
  const Ea = eaKJ * 1000;
  return Math.exp((Ea / R) * (1 / Tref - 1 / T));
};

const socStress = (socPct, exponent = 1.4) => {
  const soc = clamp(socPct, 0, 100) / 100;
  // Low SOC storage is deliberately close to 1; high SOC rises sharply.
  return 0.65 + 0.35 * Math.pow(Math.max(0.05, soc), exponent) * 2.0;
};

const dodStress = (dodPct, exponent = 1.1) =>
  Math.pow(clamp(dodPct, 5, 100) / 80, exponent);

const cRateStress = (cRate, exponent = 0.55) =>
  Math.pow(Math.max(0.05, cRate) / 0.5, exponent);

const meanSocStress = (socPct, exponent = 0.6) => {
  const soc = clamp(socPct, 5, 100) / 100;
  return 0.72 + 0.28 * Math.pow(soc / 0.5, exponent);
};

const platingStress = (tempC, chargeC, chargeEndSoc, p) => {
  if (chargeC <= p.platingCOnset || chargeEndSoc <= p.platingSocOnset || tempC >= p.platingTempOnsetC) return 0;

  const cold = clamp((p.platingTempOnsetC - tempC) / 15, 0, 2.5);
  const highSoc = clamp((chargeEndSoc - p.platingSocOnset) / (100 - p.platingSocOnset), 0, 1.5);
  const highC = Math.pow(chargeC / p.platingCOnset, 1.45) - 1;

  return Math.max(0, cold) * (0.35 + 0.65 * highSoc) * Math.max(0, highC);
};

const percentile = (values, p) => {
  if (!values.length) return 0;
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (i - lo);
};

function derivePackMetrics(series, parallel, ah, voltage, cellIr) {
  const s = Math.max(1, Math.round(safeNum(series, 1)));
  const p = Math.max(1, Math.round(safeNum(parallel, 1)));
  const a = Math.max(1, safeNum(ah, 1));
  const v = Math.max(0.5, safeNum(voltage, 3.2));
  const r = Math.max(0.001, safeNum(cellIr, 0.18));
  const totalCells = s * p;
  const nominalVoltage = s * v;
  const nominalAh = p * a;
  const nominalKwh = nominalVoltage * nominalAh / 1000;
  const packIrMilliOhm = r * s / p;

  return {
    s, p, ah: a, v, totalCells,
    nominalVoltage: Number(nominalVoltage.toFixed(1)),
    nominalAh: Number(nominalAh.toFixed(1)),
    nominalKwh: Number(nominalKwh.toFixed(2)),
    packIrMilliOhm: Number(packIrMilliOhm.toFixed(2))
  };
}

function degradationStep(state, inputs, chemistry, calibration, priors) {
  const p = priors[chemistry];
  const dtYears = Math.max(1 / 365.25, inputs.dtDays / 365.25);

  const dischargeCurrentA = inputs.dischargeC * inputs.nominalAh;
  const currentPackIrMilliOhm = inputs.initialPackIrMilliOhm * (1 + state.resistanceGrowthPct / 100);
  const i2rWatts = Math.pow(dischargeCurrentA, 2) * (currentPackIrMilliOhm / 1000);
  
  const ohmicDeltaT = clamp(i2rWatts / 400, 0, 12);
  const effectiveTempC = inputs.tempC + ohmicDeltaT;

  const tempFactor = arrheniusFactor(effectiveTempC, p.calendarEaKJ);
  const calSoc = socStress(inputs.restSocPct, p.calendarSocExponent);

  const sqrtNow = Math.sqrt(Math.max(0, state.ageYears + dtYears));
  const sqrtPrev = Math.sqrt(Math.max(0, state.ageYears));
  const sqrtIncrement = Math.max(0, sqrtNow - sqrtPrev);

  let calendarLoss =
    p.calendarRefPctAt1yr *
    tempFactor *
    calSoc *
    sqrtIncrement *
    calibration.calendarScale;

  const effectiveCRate = 0.6 * inputs.chargeC + 0.4 * inputs.dischargeC;
  const cycleStress =
    dodStress(inputs.dodPct, p.cycleDODExponent) *
    cRateStress(effectiveCRate, p.cycleCExponent) *
    meanSocStress(inputs.meanSocPct, p.cycleSocExponent) *
    arrheniusFactor(effectiveTempC, p.calendarEaKJ * 0.55);

  let cycleLoss =
    (p.cycleRefPctPer1000Efc / 1000) *
    inputs.deltaEfc *
    cycleStress *
    calibration.cycleScale;

  const plateSeverity = platingStress(
    effectiveTempC,
    inputs.chargeC,
    inputs.chargeEndSocPct,
    p
  );

  let platingLoss =
    0.010 *
    inputs.deltaEfc *
    plateSeverity *
    calibration.platingScale;

  let lli = (calendarLoss + cycleLoss + platingLoss) * p.lliShare;
  let lam = (calendarLoss + cycleLoss) * p.lamShare;

  const preSOH = clamp(100 - state.lliPct - state.lamPct, 0, 100);
  const kneeRatio = clamp((p.kneeStartSOH - preSOH) / (p.kneeStartSOH - 70), 0, 1.5);
  const kneeMultiplier = 1 + p.kneeStrength * Math.pow(kneeRatio, 2.2);

  lli *= kneeMultiplier;
  lam *= kneeMultiplier;

  const resistancePerCapacityLossPct = p.resistanceGrowthPctAt80Loss / 20;
  const baseResistanceLossPct =
    (calendarLoss + cycleLoss + platingLoss * 1.15) *
    resistancePerCapacityLossPct *
    kneeMultiplier *
    calibration.resistanceScale;

  const resistanceMultiplier =
    1 + (state.resistanceGrowthPct + baseResistanceLossPct) / 100;

  return {
    ageYears: state.ageYears + dtYears,
    efc: state.efc + inputs.deltaEfc,
    lliPct: state.lliPct + lli,
    lamPct: state.lamPct + lam,
    platingPct: state.platingPct + platingLoss,
    resistanceGrowthPct: Math.max(0, resistanceMultiplier * 100 - 100),
    breakdown: {
      calendar: state.breakdown.calendar + calendarLoss,
      cycling: state.breakdown.cycling + cycleLoss,
      plating: state.breakdown.plating + platingLoss,
      knee: state.breakdown.knee + (calendarLoss + cycleLoss + platingLoss) * Math.max(0, kneeMultiplier - 1)
    }
  };
}

function stateToMetrics(state, packKwh, efficiencyKmPerKwh, initialIr, nominalVoltage) {
  const capacityLoss = clamp(state.lliPct + state.lamPct, 0, 99.9);
  const soh = clamp(100 - capacityLoss, 0, 100);

  const packIr = initialIr * (1 + state.resistanceGrowthPct / 100);

  const i1c = (packKwh * 1000) / Math.max(1, nominalVoltage);
  const sagFrac = (i1c * (packIr / 1000)) / Math.max(1, nominalVoltage);
  const powerAccessibility = clamp(1 - Math.max(0, sagFrac - 0.05) * 1.5, 0.82, 1);

  const usableKwh = packKwh * soh / 100 * powerAccessibility;
  const rangeKm = usableKwh * efficiencyKmPerKwh;

  return {
    soh: Number(soh.toFixed(2)),
    usableKwh: Number(usableKwh.toFixed(1)),
    rangeKm: Math.round(rangeKm),
    packIr: Number(packIr.toFixed(2)),
    irMultiplier: Number((1 + state.resistanceGrowthPct / 100).toFixed(3)),
    totalEfc: Math.round(state.efc),
    breakdown: {
      calendar: Number(state.breakdown.calendar.toFixed(2)),
      cycling: Number(state.breakdown.cycling.toFixed(2)),
      plating: Number(state.breakdown.plating.toFixed(2)),
      knee: Number(state.breakdown.knee.toFixed(2))
    }
  };
}

function buildUsageProfile(params) {
  const {
    dailyKm, efficiencyKmPerKwh, packKwh,
    ambientTempC, cycleDod, chargeCrate, restSoc,
    chargeEndSoc = Math.min(100, restSoc + cycleDod)
  } = params;
  const dailyEfc = (dailyKm / Math.max(0.1, efficiencyKmPerKwh)) / Math.max(0.1, packKwh);

  return {
    dailyKm,
    dailyEfc: Math.max(0, dailyEfc),
    tempC: ambientTempC,
    dodPct: cycleDod,
    chargeC: chargeCrate,
    dischargeC: Math.max(0.1, chargeCrate * 0.75),
    meanSocPct: clamp(restSoc + cycleDod / 2, 5, 100),
    restSocPct: restSoc,
    chargeEndSocPct: chargeEndSoc
  };
}

function simulateYears(params) {
  const {
    years, chemistry, packKwh, efficiencyKmPerKwh, dailyKm,
    ambientTempC, cycleDod, chargeCrate, restSoc, eolThreshold,
    calibration, priors, dtDays = 1, startState = null,
    nominalAh, nominalVoltage, initialIr
  } = params;

  const usage = buildUsageProfile({
    dailyKm, efficiencyKmPerKwh, packKwh,
    ambientTempC, cycleDod, chargeCrate, restSoc
  });

  let state = startState || {
    ageYears: 0, efc: 0, lliPct: 0, lamPct: 0, platingPct: 0,
    resistanceGrowthPct: 0, breakdown: { calendar: 0, cycling: 0, plating: 0, knee: 0 }
  };

  const totalDays = Math.max(1, Math.round(years * 365.25));
  const dailyPoints = [];
  let eolDay = null;

  for (let day = 0; day <= totalDays; day += dtDays) {
    const metrics = stateToMetrics(state, packKwh, efficiencyKmPerKwh, initialIr, nominalVoltage);

    dailyPoints.push({
      day,
      year: Number((day / 365.25).toFixed(3)),
      ...metrics,
      odometerKm: Math.round(day * usage.dailyKm),
      state: { ...state }
    });

    if (metrics.soh <= eolThreshold && eolDay === null && day > 0) eolDay = day;
    if (day >= totalDays) break;

    state = degradationStep(
      state,
      {
        dtDays, deltaEfc: usage.dailyEfc * dtDays,
        tempC: usage.tempC, dodPct: usage.dodPct,
        chargeC: usage.chargeC, dischargeC: usage.dischargeC,
        meanSocPct: usage.meanSocPct, restSocPct: usage.restSocPct,
        chargeEndSocPct: usage.chargeEndSocPct,
        nominalAh, initialPackIrMilliOhm: initialIr
      },
      chemistry, calibration, priors
    );
  }

  return {
    dailyPoints, finalState: state,
    eolYear: eolDay === null ? null : Number((eolDay / 365.25).toFixed(2)),
    efcPerYear: usage.dailyEfc * 365.25
  };
}

// ---------------------------------------------------------------------------
// Telemetry calibration
//
// Design intent: calibration should REFINE the chemistry priors, not replace
// them. A CSV with only a handful of SOH readings carries real uncertainty,
// so we:
//   1. Bound each multiplicative scale to a "refinement band" around 1.0
//      (SCALE_MIN..SCALE_MAX) instead of letting it range freely.
//   2. Add a shrinkage penalty, in log-space, that pulls every scale back
//      toward 1.0 (i.e. back toward the stock prior). The penalty's weight
//      falls off as 1/sqrt(N), so a 3-point CSV is held close to the prior
//      while a fleet history with dozens of well-spread readings is allowed
//      to move further within the band. This mirrors a standard Bayesian/
//      ridge-regularized fit: trust the data more as evidence accumulates,
//      but never let it swing the model wildly on sparse samples.
// ---------------------------------------------------------------------------
const CALIBRATION_SCALE_MIN = 0.5;
const CALIBRATION_SCALE_MAX = 1.8;
const CALIBRATION_REG_BASE = 9; // regularization strength at N=1, decays as 1/sqrt(N)

function fitCalibrationToTelemetry(rows, baseParams) {
  const usable = rows.filter(r => Number.isFinite(r.year) && Number.isFinite(r.soh) && r.soh > 0 && r.soh <= 100);

  if (usable.length < 3) {
    return {
      calibration: { calendarScale: 1, cycleScale: 1, platingScale: 1, resistanceScale: 1 },
      rmse: null, fitted: false, dataPoints: usable.length, regWeight: null, confidence: 'insufficient',
      message: 'At least 3 measured SOH points are required for calibration.'
    };
  }

  const regWeight = CALIBRATION_REG_BASE / Math.sqrt(usable.length);
  // Rough qualitative label for the UI — purely a function of sample count,
  // it does not claim statistical rigor, just communicates how tightly the
  // fit is being held to the priors.
  const confidence = usable.length >= 24 ? 'strong' : usable.length >= 10 ? 'moderate' : 'light';

  let best = { calendarScale: 1, cycleScale: 1, platingScale: 1, resistanceScale: 1 };

  const evaluate = candidate => {
    const sim = simulateYears({
      ...baseParams,
      years: Math.max(usable[usable.length - 1].year, 0.1),
      calibration: candidate,
      dtDays: 1
    });
    let err = 0; let count = 0;

    usable.forEach(obs => {
      const idx = clamp(Math.round(obs.year * 365.25), 0, sim.dailyPoints.length - 1);
      const pred = sim.dailyPoints[idx]?.soh;
      if (Number.isFinite(pred)) {
        const w = 1 + Math.min(4, obs.year);
        err += w * Math.pow(pred - obs.soh, 2);
        count += w;
      }
    });
    const rmse = Math.sqrt(err / Math.max(1, count));

    // Log-space shrinkage toward 1.0 (the unmodified prior). Using log-space
    // keeps the penalty symmetric between e.g. a 0.7x and a 1/0.7x deviation.
    const reg = regWeight * (
      Math.pow(Math.log(candidate.calendarScale), 2) +
      Math.pow(Math.log(candidate.cycleScale), 2) +
      Math.pow(Math.log(candidate.platingScale), 2)
    );

    return { total: rmse + reg, rmse };
  };

  let bestEval = evaluate(best);
  let bestScore = bestEval.total;
  let bestRmse = bestEval.rmse;

  for (let pass = 0; pass < 5; pass++) {
    const step = [0.35, 0.18, 0.08, 0.03, 0.01][pass];
    ['calendarScale', 'cycleScale', 'platingScale'].forEach(key => {
      const candidates = [
        clamp(best[key] * (1 - step), CALIBRATION_SCALE_MIN, CALIBRATION_SCALE_MAX),
        best[key],
        clamp(best[key] * (1 + step), CALIBRATION_SCALE_MIN, CALIBRATION_SCALE_MAX)
      ];
      candidates.forEach(v => {
        const candidate = { ...best, [key]: v };
        const ev = evaluate(candidate);
        if (ev.total < bestScore) { best = candidate; bestScore = ev.total; bestRmse = ev.rmse; }
      });
    });
  }

  const maxDeviationPct = Math.round((CALIBRATION_SCALE_MAX - 1) * 100);

  return {
    calibration: best,
    rmse: Number(bestRmse.toFixed(3)),
    fitted: true,
    dataPoints: usable.length,
    regWeight: Number(regWeight.toFixed(2)),
    confidence,
    message: `Telemetry-refined SOH RMSE: ${bestRmse.toFixed(2)} pp · N=${usable.length} (${confidence} evidence) · bounded to \u00b1${maxDeviationPct}% of chemistry priors.`
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState('forecast');
  
  const [packName, setPackName] = useState('Battery Pack Digital Twin');
  const [chemistry, setChemistry] = useState('LFP');
  const [cellModel, setCellModel] = useState('EVE 230K Prismatic');
  const [cellAh, setCellAh] = useState(230);
  const [cellVoltage, setCellVoltage] = useState(3.2);
  const [packSeries, setPackSeries] = useState(192);
  const [packParallel, setPackParallel] = useState(2);
  const [eolThreshold, setEolThreshold] = useState(75);
  const [cellIrMilliOhm, setCellIrMilliOhm] = useState(0.18);

  const [efficiencyKmPerKwh, setEfficiencyKmPerKwh] = useState(0.45);
  const [dailyKm, setDailyKm] = useState(180);
  const [ambientTempC, setAmbientTempC] = useState(35);
  const [chargeCrate, setChargeCrate] = useState(1);
  const [cycleDod, setCycleDod] = useState(80);
  const [restSoc, setRestSoc] = useState(50);
  const [simulationYears, setSimulationYears] = useState(10);
  
  // Custom Prior Override State
  const [priors, setPriors] = useState(DEFAULT_PRIORS);

  const [telemetrySummary, setTelemetrySummary] = useState(null);
  const [telemetryRows, setTelemetryRows] = useState([]);
  const [csvFileName, setCsvFileName] = useState('');
  const [parseError, setParseError] = useState('');
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const [useTelemetryCalibration, setUseTelemetryCalibration] = useState(true);

  const packMetrics = useMemo(
    () => derivePackMetrics(packSeries, packParallel, cellAh, cellVoltage, cellIrMilliOhm),
    [packSeries, packParallel, cellAh, cellVoltage, cellIrMilliOhm]
  );

  const baseSimulationParams = useMemo(() => ({
    chemistry, packKwh: packMetrics.nominalKwh, efficiencyKmPerKwh, dailyKm,
    ambientTempC, cycleDod, chargeCrate, restSoc, eolThreshold, priors,
    initialIr: packMetrics.packIrMilliOhm, nominalAh: packMetrics.nominalAh, nominalVoltage: packMetrics.nominalVoltage
  }), [
    chemistry, packMetrics.nominalKwh, packMetrics.packIrMilliOhm,
    packMetrics.nominalAh, packMetrics.nominalVoltage, efficiencyKmPerKwh, 
    dailyKm, ambientTempC, cycleDod, chargeCrate, restSoc, eolThreshold, priors
  ]);

  const updatePrior = (key, value) => {
    if (!Number.isNaN(value)) {
      setPriors(prev => ({
        ...prev,
        [chemistry]: {
          ...prev[chemistry],
          [key]: value
        }
      }));
    }
  };

  const calibrationResult = useMemo(() => {
    if (!useTelemetryCalibration || !telemetryRows.length) {
      return {
        calibration: { calendarScale: 1, cycleScale: 1, platingScale: 1, resistanceScale: 1 },
        rmse: null, fitted: false, dataPoints: 0, regWeight: null, confidence: null,
        message: 'Using explicit priors; no telemetry calibration active.'
      };
    }
    return fitCalibrationToTelemetry(telemetryRows, baseSimulationParams);
  }, [telemetryRows, useTelemetryCalibration, baseSimulationParams]);

  const calibration = calibrationResult.calibration;

  const timelineData = useMemo(() => {
    const sim = simulateYears({
      ...baseSimulationParams,
      years: Math.max(3, simulationYears),
      calibration, dtDays: 1
    });

    let baselinePoints = null;
    if (useTelemetryCalibration && telemetryRows.length > 0) {
      const bSim = simulateYears({
        ...baseSimulationParams,
        years: Math.max(3, simulationYears),
        calibration: { calendarScale: 1, cycleScale: 1, platingScale: 1, resistanceScale: 1 },
        dtDays: 1
      });
      const displayEveryDays = Math.max(1, Math.round(0.25 * 365.25));
      baselinePoints = bSim.dailyPoints.filter((p, i) => i === 0 || i === bSim.dailyPoints.length - 1 || i % displayEveryDays === 0);
    }

    const displayEveryDays = Math.max(1, Math.round(0.25 * 365.25));
    const points = sim.dailyPoints.filter((p, i) => i === 0 || i === sim.dailyPoints.length - 1 || i % displayEveryDays === 0);

    const measured = telemetryRows.filter(r => Number.isFinite(r.year) && Number.isFinite(r.soh));
    points.forEach(p => {
      let best = null; let bestDist = Infinity;
      measured.forEach(m => {
        const d = Math.abs(m.year - p.year);
        if (d < bestDist) { bestDist = d; best = m; }
      });
      if (best && bestDist < 0.13) p.measuredSoh = best.soh;
    });

    const minSoh = Math.min(...points.map(p => p.soh), ...(baselinePoints ? baselinePoints.map(p => p.soh) : []));
    const yMin = Math.max(0, Math.floor((minSoh - 4) / 5) * 5);

    return {
      ...sim, points, baselinePoints,
      effectiveHorizon: Math.max(1, points[points.length - 1]?.year || 1),
      yMin, yMax: 100, yRange: Math.max(10, 100 - yMin)
    };
  }, [baseSimulationParams, simulationYears, calibration, telemetryRows, useTelemetryCalibration]);

  const currentYear0 = timelineData.points[0] || {};
  const currentYear5 = timelineData.dailyPoints[Math.min(timelineData.dailyPoints.length - 1, Math.round(5 * 365.25))] || timelineData.points[timelineData.points.length - 1];

  const handleCSV = (content, fileName) => {
    try {
      setParseError('');

      const rawLines = content
        .replace(/\r/g, '')
        .split('\n')
        .filter(line => line.trim().length);

      if (rawLines.length < 2) throw new Error('CSV has fewer than 2 rows.');

      const splitCSV = line => {
        const out = [];
        let current = '';
        let quoted = false;

        for (let i = 0; i < line.length; i++) {
          const c = line[i];
          if (c === '"') quoted = !quoted;
          else if (c === ',' && !quoted) {
            out.push(current.trim());
            current = '';
          } else current += c;
        }
        out.push(current.trim());
        return out;
      };

      const headers = splitCSV(rawLines[0]).map(h =>
        h.toLowerCase().replace(/[^a-z0-9]/g, '')
      );

      const findCol = keys =>
        headers.findIndex(h => keys.some(k => h.includes(k)));

      const idxTime = findCol(['timestamp', 'datetime', 'date', 'time', 'epoch']);
      const idxTemp = findCol(['tempc', 'packtemp', 'temperature', 'temp']);
      const idxSoc = findCol(['socpct', 'soc', 'stateofcharge']);
      const idxSoh = findCol(['sohpct', 'soh', 'stateofhealth', 'health']);
      const idxCurrent = findCol(['currenta', 'current']);
      const idxVoltage = findCol(['voltagev', 'voltage']);
      const idxDistance = findCol(['distancekm', 'distance', 'km']);
      const idxDod = findCol(['dodpct', 'dod', 'depthofdischarge']);
      const idxChargeC = findCol(['chargecrate', 'chargec', 'crate']);
      const idxDischargeC = findCol(['dischargecrate', 'dischargec']);
      const idxRestSoc = findCol(['restsocpct', 'restsoc']);

      const parsed = [];
      let timestamps = [];

      for (let i = 1; i < rawLines.length; i++) {
        const cols = splitCSV(rawLines[i]);
        if (!cols.length) continue;

        const temp = idxTemp >= 0 ? safeNum(cols[idxTemp], ambientTempC) : ambientTempC;
        const soc = idxSoc >= 0 ? safeNum(cols[idxSoc], restSoc) : restSoc;
        const soh = idxSoh >= 0 ? safeNum(cols[idxSoh], NaN) : NaN;
        const currentA = idxCurrent >= 0 ? safeNum(cols[idxCurrent], 0) : 0;
        const voltageV = idxVoltage >= 0 ? safeNum(cols[idxVoltage], packMetrics.nominalVoltage) : packMetrics.nominalVoltage;
        const distanceKm = idxDistance >= 0 ? safeNum(cols[idxDistance], 0) : 0;
        const dod = idxDod >= 0 ? safeNum(cols[idxDod], cycleDod) : cycleDod;
        const chargeC = idxChargeC >= 0 ? safeNum(cols[idxChargeC], chargeCrate) : chargeCrate;
        const dischargeC = idxDischargeC >= 0 ? safeNum(cols[idxDischargeC], Math.max(0.1, chargeCrate * 0.75)) : Math.max(0.1, chargeCrate * 0.75);
        const rest = idxRestSoc >= 0 ? safeNum(cols[idxRestSoc], restSoc) : restSoc;

        let epoch = null;
        if (idxTime >= 0) {
          const raw = cols[idxTime];
          const parsedDate = Date.parse(raw);
          if (!Number.isNaN(parsedDate)) epoch = parsedDate;
          else {
            const n = Number(raw);
            if (Number.isFinite(n)) epoch = n > 1e12 ? n : n * 1000;
          }
        }

        if (epoch !== null) timestamps.push(epoch);

        parsed.push({
          index: i - 1,
          epoch,
          tempC: temp,
          socPct: soc,
          soh: Number.isFinite(soh) ? clamp(soh, 0, 100) : null,
          currentA,
          voltageV,
          distanceKm,
          dodPct: dod,
          chargeC,
          dischargeC,
          restSocPct: rest
        });
      }

      if (!parsed.length) throw new Error('Could not parse numerical rows.');

      timestamps = timestamps.filter(Number.isFinite).sort((a, b) => a - b);

      let spanDays = Math.max(1, parsed.length);
      if (timestamps.length >= 2) {
        spanDays = Math.max(1, (timestamps[timestamps.length - 1] - timestamps[0]) / 86400000);
      }

      const firstEpoch = timestamps[0] ?? 0;
      const mean = key =>
        parsed.reduce((s, r) => s + safeNum(r[key], 0), 0) / Math.max(1, parsed.length);

      const minSoc = Math.min(...parsed.map(r => r.socPct));
      const maxSoc = Math.max(...parsed.map(r => r.socPct));

      const totalDistance = parsed.reduce((s, r) => s + Math.max(0, r.distanceKm), 0);
      const totalAhThroughput = timestamps.length >= 2
        ? parsed.reduce((s, r, i) => {
            if (i === 0 || r.epoch === null || parsed[i - 1].epoch === null) return s;
            const dtH = Math.max(0, (r.epoch - parsed[i - 1].epoch) / 3600000);
            return s + Math.abs(r.currentA) * dtH;
          }, 0)
        : 0;

      const annualEfcFromAh = totalAhThroughput > 0
        ? (totalAhThroughput / (2 * packMetrics.nominalAh)) * (365.25 / Math.max(1, spanDays))
        : 0;

      const annualDistance = totalDistance > 0
        ? totalDistance * (365.25 / Math.max(1, spanDays))
        : dailyKm * 365.25;

      const historicalRows = parsed
        .filter(r => Number.isFinite(r.soh))
        .map(r => ({
          year: r.epoch !== null && firstEpoch
            ? (r.epoch - firstEpoch) / (365.25 * 86400000)
            : (r.index / Math.max(1, parsed.length - 1)) * (spanDays / 365.25),
          soh: r.soh
        }))
        .filter(r => r.year >= 0);

      setTelemetryRows(historicalRows);
      setCsvFileName(fileName);
      
      if (idxDistance >= 0 && totalDistance > 0) {
        setDailyKm(clamp(Math.round(totalDistance / Math.max(1, spanDays)), 5, 1000));
      }
      setAmbientTempC(clamp(Math.round(mean('tempC')), -10, 60));
      setRestSoc(clamp(Math.round(mean('socPct')), 10, 100));
      setCycleDod(clamp(Math.round(mean('dodPct')), 10, 100));
      setChargeCrate(clamp(Number(mean('chargeC').toFixed(2)), 0.1, 5));

      setTelemetrySummary({
        validRows: parsed.length,
        spanDays: Number(spanDays.toFixed(1)),
        spanYears: Number((spanDays / 365.25).toFixed(2)),
        meanTemp: Number(mean('tempC').toFixed(1)),
        meanSoc: Number(mean('socPct').toFixed(1)),
        meanDod: Number(clamp(maxSoc - minSoc, 0, 100).toFixed(0)),
        annualEfc: Number((annualEfcFromAh || ((annualDistance / Math.max(0.1, efficiencyKmPerKwh)) / packMetrics.nominalKwh)).toFixed(0)),
        measuredSohPoints: historicalRows.length,
        totalDistanceKm: Math.round(totalDistance)
      });
    } catch (e) {
      setParseError(e.message);
      setTelemetryRows([]);
      setTelemetrySummary(null);
    }
  };

  const resetTelemetry = () => {
    setTelemetryRows([]); setTelemetrySummary(null); setCsvFileName(''); setParseError(''); setUseTelemetryCalibration(true);
  };

  return (
    <div style={{
      minHeight: '100vh', backgroundColor: '#090a0f', color: '#e2e8f0',
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif', padding: '20px 24px', boxSizing: 'border-box'
    }}>
      <header style={headerStyle}>
        <div style={badgeStyle}>PHYSICS-INFORMED DIGITAL TWIN</div>
        <h1 style={{ fontSize: '22px', fontWeight: 700, margin: '6px 0 0', color: '#f8fafc' }}>{packName}</h1>
        <div style={monoSubStyle}>
          {chemistry} | {packMetrics.s}S{packMetrics.p}P ({packMetrics.totalCells} Cells) | {packMetrics.nominalVoltage} V | {packMetrics.nominalAh} Ah | <strong style={{ color: '#38bdf8' }}>{packMetrics.nominalKwh} kWh</strong>
        </div>
      </header>

      <div style={kpiGridStyle}>
        <Kpi label="Initial Range Autonomy" value={`${currentYear0.rangeKm} km`} sub={`${packMetrics.nominalKwh} kWh @ ${efficiencyKmPerKwh} km/kWh`} color="#38bdf8" />
        <Kpi label="5-Year Projected State" value={`${currentYear5.soh}% SOH`} sub={`${currentYear5.usableKwh} kWh · ${currentYear5.rangeKm} km remaining`} color={currentYear5.soh <= eolThreshold ? '#f87171' : '#4ade80'} />
        <Kpi label={`RUL to ${eolThreshold}% EOL`} value={timelineData.eolYear ? `${timelineData.eolYear} yr` : `>${simulationYears} yr`} sub={`~${timelineData.efcPerYear.toFixed(0)} EFC/yr`} color="#fbbf24" />
        <Kpi label="Pack DC Resistance" value={`${currentYear5.packIr} mΩ`} sub={`+${((currentYear5.irMultiplier - 1) * 100).toFixed(0)}% vs fresh`} color="#c084fc" />
      </div>

      <div style={tabsStyle}>
        {[
          ['forecast', '📈 Trajectory Forecast'],
          ['specs', '⚙️ Pack Architecture & Specs'],
          ['breakdown', '🔬 Degradation Breakdown'],
          ['advanced', '🎛️ Advanced Settings'],
          ['telemetry', `📁 Fleet Telemetry${telemetrySummary ? ` (${telemetrySummary.validRows})` : ''}`]
        ].map(([id, label]) => (
          <button key={id} onClick={() => setActiveTab(id)} style={tabStyle(activeTab === id)}>{label}</button>
        ))}
      </div>

      {activeTab === 'forecast' && (
        <div style={responsiveTwoColStyle}>
          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Operational Stress Factors</h3>
            <ControlRange label={`Daily Utilization (${dailyKm} km/day)`} min={30} max={600} step={10} value={dailyKm} onChange={setDailyKm} />
            <ControlRange label={`Operational Pack Temp (${ambientTempC}°C)`} min={5} max={55} step={1} value={ambientTempC} onChange={setAmbientTempC} />
            <div style={warningStyle(ambientTempC > 40 || ambientTempC < 15)}>
              {ambientTempC > 40 ? '⚠ High temperature accelerates calendar/cycle ageing' :
               ambientTempC < 15 ? '⚠ Low temperature increases charge-side plating risk' :
               'Normal thermal range'}
            </div>
            <ControlRange label={`Fast Charge C-Rate (${chargeCrate}C)`} min={0.2} max={2} step={0.05} value={chargeCrate} onChange={setChargeCrate} />
            <ControlRange label={`Cycle Depth DOD (${cycleDod}%)`} min={30} max={100} step={5} value={cycleDod} onChange={setCycleDod} />
            <ControlRange label={`Resting SOC (${restSoc}%)`} min={20} max={95} step={5} value={restSoc} onChange={setRestSoc} />
            <NumberControl label="Specific Consumption (km/kWh)" value={efficiencyKmPerKwh} step={0.05} min={0.2} max={8} onChange={v => setEfficiencyKmPerKwh(v || 0.35)} />
            <NumberControl label="Projection Horizon (Years)" value={simulationYears} step={1} min={3} max={20} onChange={v => setSimulationYears(Math.round(v || 8))} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={panelStyle}>
              <div style={chartHeaderStyle}>
                <div>
                  <h3 style={chartTitleStyle}>SOH & Available Range Fade Trajectory</h3>
                  <div style={mutedTextStyle}>
                    Daily degradation engine · quarterly display points · telemetry measured SOH shown as circles
                  </div>
                </div>
                <div style={legendStyle}>
                  <span style={{ color: '#38bdf8' }}>━ {timelineData.baselinePoints ? 'Calibrated SOH' : 'Model SOH'}</span>
                  {timelineData.baselinePoints && <span style={{ color: '#64748b' }}>┄ Baseline SOH</span>}
                  <span style={{ color: '#4ade80' }}>┄ Range</span>
                  <span style={{ color: '#f87171' }}>┄ {eolThreshold}% EOL</span>
                  {telemetryRows.length > 0 && <span style={{ color: '#fbbf24' }}>● Measured SOH</span>}
                </div>
              </div>

              <div style={{ width: '100%', height: 320, position: 'relative' }}>
                <svg viewBox="0 0 700 280" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio, idx) => {
                    const y = 22 + ratio * 210;
                    const sohVal = timelineData.yMax - ratio * timelineData.yRange;
                    const rangeVal = Math.round((sohVal / 100) * packMetrics.nominalKwh * efficiencyKmPerKwh);
                    return (
                      <g key={idx}>
                        <line x1="58" y1={y} x2="625" y2={y} stroke="#1e2433" strokeDasharray="3" />
                        <text x="50" y={y + 4} fill="#64748b" fontSize="10" textAnchor="end" fontFamily="monospace">{sohVal.toFixed(0)}%</text>
                        <text x="633" y={y + 4} fill="#4ade80" fontSize="10" textAnchor="start" fontFamily="monospace">{Math.max(0, rangeVal)} km</text>
                      </g>
                    );
                  })}

                  {eolThreshold >= timelineData.yMin && eolThreshold <= 100 && (() => {
                    const y = 22 + ((100 - eolThreshold) / timelineData.yRange) * 210;
                    return (
                      <g>
                        <line x1="58" y1={y} x2="625" y2={y} stroke="#f87171" strokeWidth="1.5" strokeDasharray="4" />
                        <text x="620" y={y - 5} fill="#f87171" fontSize="9" textAnchor="end">{eolThreshold}% EOL</text>
                      </g>
                    );
                  })()}

                  {(() => {
                    const pts = timelineData.points;
                    const maxH = Math.max(1, timelineData.effectiveHorizon);
                    const getX = yr => 58 + (yr / maxH) * 567;
                    const getY = soh => 22 + ((100 - Math.max(timelineData.yMin, soh)) / timelineData.yRange) * 210;

                    const maxRange = packMetrics.nominalKwh * efficiencyKmPerKwh;
                    const rangePath = pts.map((p, i) => {
                      const equiv = (p.rangeKm / Math.max(0.1, maxRange)) * 100;
                      return `${i ? 'L' : 'M'} ${getX(p.year)} ${getY(equiv)}`;
                    }).join(' ');

                    let baselinePath = '';
                    if (timelineData.baselinePoints) {
                      baselinePath = timelineData.baselinePoints.map((p, i) => `${i ? 'L' : 'M'} ${getX(p.year)} ${getY(p.soh)}`).join(' ');
                    }

                    let historyPts = [];
                    let projPts = [];
                    const hasTelemetry = telemetryRows.length > 0;
                    const lastTelemetryYear = hasTelemetry ? Math.max(...telemetryRows.map(r => r.year)) : 0;

                    if (hasTelemetry) {
                      historyPts = pts.filter(p => p.year <= lastTelemetryYear);
                      projPts = pts.filter(p => p.year >= lastTelemetryYear);
                      if (historyPts.length > 0 && projPts.length > 0 && projPts[0].year !== historyPts[historyPts.length - 1].year) {
                        projPts.unshift(historyPts[historyPts.length - 1]);
                      }
                    } else {
                      historyPts = pts;
                    }

                    const historyPath = historyPts.map((p, i) => `${i ? 'L' : 'M'} ${getX(p.year)} ${getY(p.soh)}`).join(' ');
                    const projPath = projPts.map((p, i) => `${i ? 'L' : 'M'} ${getX(p.year)} ${getY(p.soh)}`).join(' ');

                    return (
                      <g>
                        <path d={rangePath} fill="none" stroke="#4ade80" strokeWidth="2" strokeDasharray="5 4" opacity="0.85" />
                        
                        {baselinePath && <path d={baselinePath} fill="none" stroke="#64748b" strokeWidth="2" opacity="0.6" strokeDasharray="4 4" />}
                        {historyPath && <path d={historyPath} fill="none" stroke="#38bdf8" strokeWidth="3" />}
                        {projPath && hasTelemetry && <path d={projPath} fill="none" stroke="#38bdf8" strokeWidth="3" strokeDasharray="6 4" />}

                        {pts.map((p, i) => (
                          <circle
                            key={i}
                            cx={getX(p.year)}
                            cy={getY(p.soh)}
                            r="3"
                            fill="#0284c7"
                            stroke="#090a0f"
                            strokeWidth="1.5"
                            onMouseEnter={() => setHoveredPoint(p)}
                            style={{ cursor: 'pointer' }}
                          />
                        ))}

                        {pts.filter(p => Number.isFinite(p.measuredSoh)).map((p, i) => (
                          <circle
                            key={`m-${i}`}
                            cx={getX(p.year)}
                            cy={getY(p.measuredSoh)}
                            r="5"
                            fill="#fbbf24"
                            stroke="#090a0f"
                            strokeWidth="2"
                          />
                        ))}
                      </g>
                    );
                  })()}

                  {Array.from({ length: Math.ceil(timelineData.effectiveHorizon) + 1 }).map((_, i) => {
                    const x = 58 + (i / Math.max(1, timelineData.effectiveHorizon)) * 567;
                    return <text key={i} x={x} y="258" fill="#64748b" fontSize="10" textAnchor="middle" fontFamily="monospace">Y{i}</text>;
                  })}
                </svg>

                {hoveredPoint && (
                  <div style={tooltipStyle}>
                    <div style={{ color: '#38bdf8', fontWeight: 700 }}>Year {hoveredPoint.year}</div>
                    <div>SOH: <strong>{hoveredPoint.soh}%</strong></div>
                    <div>Usable: {hoveredPoint.usableKwh} kWh</div>
                    <div>Range: {hoveredPoint.rangeKm} km</div>
                    <div>R: {hoveredPoint.packIr} mΩ ({hoveredPoint.irMultiplier}×)</div>
                    <div>EFC: {hoveredPoint.totalEfc}</div>
                  </div>
                )}
              </div>
            </div>

            <div style={{ ...panelStyle, overflowX: 'auto' }}>
              <h4 style={sectionHeadingStyle}>Quarterly State of Health Schedule</h4>
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeadStyle}>
                    <th>Year</th><th>SOH</th><th>Usable Pack</th><th>Range</th><th>EFC</th><th>DC R</th><th>Calendar</th><th>Cycle</th><th>Plating</th><th>Knee</th>
                  </tr>
                </thead>
                <tbody>
                  {timelineData.points.map((pt, i) => (
                    <tr key={i} style={tableRowStyle(pt.soh <= eolThreshold)}>
                      <td>{pt.year.toFixed(2)}</td>
                      <td><strong>{pt.soh}%</strong></td>
                      <td>{pt.usableKwh} kWh</td>
                      <td>{pt.rangeKm} km</td>
                      <td>{pt.totalEfc}</td>
                      <td>{pt.packIr} mΩ</td>
                      <td>{pt.breakdown.calendar}%</td>
                      <td>{pt.breakdown.cycling}%</td>
                      <td>{pt.breakdown.plating}%</td>
                      <td>{pt.breakdown.knee}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'specs' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Pack Mechanical & Electrical Architecture</h3>
            <TextControl label="Pack Designation Name" value={packName} onChange={setPackName} />
            <div style={twoColInputStyle}>
              <SelectControl label="Cell Chemistry" value={chemistry} onChange={setChemistry} options={[
                ['LFP', 'LFP (Lithium Iron Phosphate)'],
                ['NMC', 'NMC (Nickel Manganese Cobalt)']
              ]} />
              <TextControl label="Cell Specification Model" value={cellModel} onChange={setCellModel} />
            </div>
            <div style={twoColInputStyle}>
              <NumberControl label="Series Cells (S)" value={packSeries} step={1} min={1} max={1000} onChange={setPackSeries} />
              <NumberControl label="Parallel Strands (P)" value={packParallel} step={1} min={1} max={50} onChange={setPackParallel} />
            </div>
            <div style={twoColInputStyle}>
              <NumberControl label="Cell Nominal Capacity (Ah)" value={cellAh} step={1} min={10} max={1000} onChange={setCellAh} />
              <NumberControl label="Cell Nominal Voltage (V)" value={cellVoltage} step={0.05} min={1.5} max={4.5} onChange={setCellVoltage} />
            </div>
            <div style={twoColInputStyle}>
              <NumberControl label="Cell Initial DC Resistance (mΩ)" value={cellIrMilliOhm} step={0.01} min={0.01} max={5} onChange={setCellIrMilliOhm} />
              <NumberControl label="Fleet EOL Cutoff (%)" value={eolThreshold} step={1} min={50} max={90} onChange={setEolThreshold} />
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Synthesized Physical Parameters</h3>
            {[
              ['Total Cell Count', `${packMetrics.totalCells} cells`],
              ['Pack Nominal Voltage', `${packMetrics.nominalVoltage} V`],
              ['Pack Total Ah Capacity', `${packMetrics.nominalAh} Ah`],
              ['Gross Nameplate Energy', `${packMetrics.nominalKwh} kWh`],
              ['Pack Initial DC Resistance', `${packMetrics.packIrMilliOhm} mΩ`],
              ['Calendar Activation Energy Prior', `${priors[chemistry].calendarEaKJ} kJ/mol`],
              ['Model Architecture', 'LLI + LAM + plating + independent resistance']
            ].map(([a, b], i) => (
              <div key={i} style={derivedRowStyle}><span>{a}</span><strong>{b}</strong></div>
            ))}

            <div style={infoBoxStyle}>
              <strong>Important:</strong> the chemistry values are research-informed priors, not universal properties of every LFP or NMC cell. Uploading measured SOH data enables the in-browser calibration layer to <em>refine</em> those priors within a bounded band — see the Fleet Telemetry tab for how much the fit is allowed to move and why.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'breakdown' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>5-Year Loss Mechanism Partitioning</h3>
            {[
              ['LLI / Calendar', currentYear5.breakdown.calendar, '#38bdf8'],
              ['Cycling / LAM', currentYear5.breakdown.cycling, '#4ade80'],
              ['Lithium Plating', currentYear5.breakdown.plating, '#f87171'],
              ['Non-linear Knee Acceleration', currentYear5.breakdown.knee, '#fbbf24']
            ].map(([name, val, color]) => (
              <div key={name} style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                  <span>{name}</span><span style={{ color, fontFamily: 'monospace' }}>{val}%</span>
                </div>
                <div style={{ height: 8, background: '#1e2433', borderRadius: 4 }}>
                  <div style={{ width: `${Math.min(100, Math.max(0, val * 6))}%`, height: '100%', background: color, borderRadius: 4 }} />
                </div>
              </div>
            ))}

            <div style={infoBoxStyle}>
              Capacity SOH = 100 − (LLI + LAM). Resistance is intentionally not inferred directly from capacity loss; it is accumulated as a separate state.
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Model Architecture & Assumptions</h3>
            <div style={referenceTextStyle}>
              <p><strong>Calendar ageing:</strong> Arrhenius temperature dependence, resting-SOC stress and diffusion-like √time growth.</p>
              <p><strong>Cycle ageing:</strong> incremental EFC accumulation with DOD, mean SOC, C-rate and temperature stress.</p>
              <p><strong>Lithium plating:</strong> charge-only risk, activated by low temperature, high charging C-rate and high charge-end SOC.</p>
              <p><strong>Degradation modes:</strong> capacity fade is separated into LLI and LAM rather than treating all fade as one scalar loss.</p>
              <p><strong>Knee:</strong> acceleration emerges smoothly as SOH falls; there is no fixed chemistry-wide EFC knee.</p>
              <p><strong>Resistance:</strong> accumulated independently from capacity fade and translated into a modest usable-energy accessibility penalty.</p>
              <p><strong>Telemetry calibration:</strong> a bounded, shrinkage-regularized fit — see the Fleet Telemetry tab — refines calendar/cycle/plating scale factors toward the measured SOH history without discarding the chemistry priors.</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'advanced' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Degradation Model Parameters ({chemistry})</h3>
            <NumberControl label="Calendar Base Fade (% per √yr)" value={priors[chemistry].calendarRefPctAt1yr} step={0.05} min={0.1} max={10} onChange={v => updatePrior('calendarRefPctAt1yr', v)} />
            <NumberControl label="Cycle Base Fade (% per 1000 EFC)" value={priors[chemistry].cycleRefPctPer1000Efc} step={0.1} min={0.1} max={20} onChange={v => updatePrior('cycleRefPctPer1000Efc', v)} />
            <NumberControl label="Degradation Knee Onset (SOH %)" value={priors[chemistry].kneeStartSOH} step={1} min={50} max={98} onChange={v => updatePrior('kneeStartSOH', v)} />
            <NumberControl label="Knee Downward Strength Factor" value={priors[chemistry].kneeStrength} step={0.1} min={0} max={5} onChange={v => updatePrior('kneeStrength', v)} />
            <NumberControl label="Lithium Plating Temp Threshold (°C)" value={priors[chemistry].platingTempOnsetC} step={1} min={-10} max={30} onChange={v => updatePrior('platingTempOnsetC', v)} />
            
            <button onClick={() => setPriors(DEFAULT_PRIORS)} style={{ ...secondaryButtonStyle, marginTop: 24 }}>
              ↺ Reset Chemistries to Default
            </button>
          </div>

          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Parameter Explanations</h3>
            <div style={referenceTextStyle}>
              <p><strong>Calendar Base Fade:</strong> Percentage capacity loss over the first year at reference storage conditions (25°C, 50% SOC). It inherently scales with the square root of time.</p>
              <p><strong>Cycle Base Fade:</strong> Capacity loss per 1000 Equivalent Full Cycles (EFC) at nominal reference conditions (25°C, 1C rate, and 80% DOD). <br/><br/><em>Note: Modern LFP prismatic cells like the EVE LF230 typically sit in the 2.5% zone (which scales mathematically to yield ~6000 cycles to 80% SOH under standard stress profiles).</em></p>
              <p><strong>Knee Onset:</strong> The State of Health at which the exponential degradation knee begins to rapidly accelerate capacity fade. LFP usually maintains a flatter curve for longer before kneeing near 80-85%.</p>
              <p><strong>Knee Strength:</strong> Determines how sharply the continuous degradation rate multipliers scale once the battery dips past the knee onset SOH.</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'telemetry' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) 1fr', gap: 20 }}>
          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Upload Fleet Telemetry CSV</h3>
            <p style={mutedParagraphStyle}>
              Recommended columns: timestamp, temp_C, SOC_pct, SOH_pct, current_A, voltage_V, distance_km, DOD_pct, charge_C, discharge_C, rest_SOC_pct.
            </p>
            <input
              type="file"
              accept=".csv"
              onChange={e => {
                const f = e.target.files?.[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = evt => handleCSV(String(evt.target.result), f.name);
                reader.readAsText(f);
              }}
              style={{ fontSize: 12, color: '#94a3b8', width: '100%' }}
            />

            {csvFileName && (
              <div style={{ marginTop: 10, color: '#4ade80', fontSize: 12 }}>
                ✓ Attached: <strong>{csvFileName}</strong>
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 12, color: '#cbd5e1' }}>
              <input
                type="checkbox"
                checked={useTelemetryCalibration}
                onChange={e => setUseTelemetryCalibration(e.target.checked)}
              />
              Calibrate ageing parameters from measured SOH
            </label>

            <button onClick={resetTelemetry} style={secondaryButtonStyle}>Reset telemetry</button>

            {parseError && <div style={errorBoxStyle}>{parseError}</div>}

            <div style={infoBoxStyle}>
              <strong>How calibration works:</strong> the fit is bounded to ±{Math.round((CALIBRATION_SCALE_MAX - 1) * 100)}% of the chemistry prior for each of the calendar, cycle and plating scale factors, and is shrunk back toward the prior (1.0×) in proportion to 1/√N. A 3–5 point CSV will nudge the model gently; a fleet history with 20+ well-spread readings can move it further within that band. It never fully replaces the underlying physics.
            </div>
          </div>

          <div style={panelStyle}>
            <h3 style={sectionHeadingStyle}>Telemetry Diagnostics & Calibration</h3>
            {telemetrySummary ? (
              <>
                {[
                  ['Valid records', `${telemetrySummary.validRows}`],
                  ['Time span', `${telemetrySummary.spanDays} days (${telemetrySummary.spanYears} yr)`],
                  ['Mean battery temperature', `${telemetrySummary.meanTemp}°C`],
                  ['Mean SOC', `${telemetrySummary.meanSoc}%`],
                  ['Observed SOC window', `${telemetrySummary.meanDod}% DOD`],
                  ['Annualized EFC', `${telemetrySummary.annualEfc} EFC/yr`],
                  ['Measured SOH points', `${telemetrySummary.measuredSohPoints}`],
                  ['Distance in file', `${telemetrySummary.totalDistanceKm} km`]
                ].map(([a, b]) => <div key={a} style={derivedRowStyle}><span>{a}</span><strong>{b}</strong></div>)}

                <div style={{ marginTop: 16, padding: 12, borderRadius: 6, border: '1px solid #1e2433', background: '#090a0f' }}>
                  <div style={{ fontSize: 11, color: '#38bdf8', textTransform: 'uppercase', marginBottom: 5 }}>Settings Auto-Extracted</div>
                  <div style={{ color: '#cbd5e1', fontSize: 12, lineHeight: 1.5 }}>
                    Base parameters (temp, DOD, SOC, C-rate, daily km) were automatically updated to reflect the uploaded fleet average. You can override them in the Forecast tab at any time.
                  </div>
                </div>

                <div style={{ marginTop: 16, padding: 12, borderRadius: 6, border: '1px solid #1e2433', background: '#090a0f' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                    <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase' }}>Calibration status</div>
                    {calibrationResult.fitted && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: calibrationResult.confidence === 'strong' ? '#4ade80' : calibrationResult.confidence === 'moderate' ? '#fbbf24' : '#94a3b8', textTransform: 'uppercase' }}>
                        {calibrationResult.confidence} evidence
                      </div>
                    )}
                  </div>
                  <div style={{ color: calibrationResult.fitted ? '#4ade80' : '#94a3b8', fontSize: 13 }}>
                    {calibrationResult.message}
                  </div>
                  {calibrationResult.fitted && (
                    <div style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11, color: '#cbd5e1' }}>
                      Calendar × {calibration.calendarScale.toFixed(3)} ·
                      Cycle × {calibration.cycleScale.toFixed(3)} ·
                      Plating × {calibration.platingScale.toFixed(3)}
                      <br />
                      SOH fit RMSE: {calibrationResult.rmse} percentage points · shrinkage weight λ={calibrationResult.regWeight}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ color: '#64748b', fontSize: 12, fontStyle: 'italic' }}>
                No telemetry loaded. The simulation is running from explicitly defined physical priors.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, color }) {
  return (
    <div style={kpiCardStyle}>
      <div style={kpiLabelStyle}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color, marginTop: 4, fontFamily: 'monospace' }}>{value}</div>
      <div style={kpiSubStyle}>{sub}</div>
    </div>
  );
}

function ControlRange({ label, min, max, step, value, onChange }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#38bdf8' }}
      />
    </div>
  );
}

function NumberControl({ label, value, step, min, max, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        max={max}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={inputNumberStyle}
      />
    </div>
  );
}

function TextControl({ label, value, onChange }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} style={inputTextStyle} />
    </div>
  );
}

function SelectControl({ label, value, onChange, options }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={labelStyle}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={inputTextStyle}>
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </div>
  );
}

const headerStyle = {
  borderBottom: '1px solid #1e2433',
  paddingBottom: 16,
  marginBottom: 20
};

const badgeStyle = {
  display: 'inline-block',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.6px',
  background: '#1e293b',
  color: '#38bdf8',
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid #334155'
};

const monoSubStyle = {
  fontSize: 13,
  color: '#94a3b8',
  marginTop: 4,
  fontFamily: 'monospace'
};

const kpiGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  gap: 12,
  marginBottom: 20
};

const kpiCardStyle = {
  background: '#0e111a',
  border: '1px solid #1e2433',
  borderRadius: 8,
  padding: '14px 16px'
};

const kpiLabelStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.5px'
};

const kpiSubStyle = {
  fontSize: 11,
  color: '#64748b',
  marginTop: 3
};

const tabsStyle = {
  display: 'flex',
  gap: 4,
  borderBottom: '1px solid #1e2433',
  marginBottom: 18,
  flexWrap: 'wrap'
};

const tabStyle = active => ({
  background: 'transparent',
  border: 'none',
  borderBottom: active ? '2px solid #38bdf8' : '2px solid transparent',
  color: active ? '#38bdf8' : '#64748b',
  padding: '8px 14px',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer'
});

const responsiveTwoColStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(300px, 340px) minmax(0, 1fr)',
  gap: 20
};

const panelStyle = {
  background: '#0e111a',
  border: '1px solid #1e2433',
  borderRadius: 8,
  padding: 16,
  minWidth: 0,
  boxSizing: 'border-box'
};

const sectionHeadingStyle = {
  margin: '0 0 12px',
  fontSize: 13,
  fontWeight: 700,
  color: '#f8fafc',
  borderBottom: '1px solid #1e2433',
  paddingBottom: 6
};

const labelStyle = {
  fontSize: 11,
  color: '#94a3b8',
  display: 'block',
  marginBottom: 4,
  fontWeight: 500
};

const inputNumberStyle = {
  width: '100%',
  padding: '7px 10px',
  background: '#090a0f',
  border: '1px solid #1e2433',
  borderRadius: 6,
  color: '#f8fafc',
  fontSize: 12,
  fontFamily: 'monospace',
  boxSizing: 'border-box'
};

const inputTextStyle = {
  width: '100%',
  padding: '7px 10px',
  background: '#090a0f',
  border: '1px solid #1e2433',
  borderRadius: 6,
  color: '#f8fafc',
  fontSize: 12,
  boxSizing: 'border-box'
};

const twoColInputStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12
};

const chartHeaderStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
  gap: 12,
  flexWrap: 'wrap'
};

const chartTitleStyle = {
  margin: 0,
  fontSize: 14,
  fontWeight: 700,
  color: '#f8fafc'
};

const mutedTextStyle = {
  fontSize: 11,
  color: '#64748b',
  marginTop: 3
};

const legendStyle = {
  display: 'flex',
  gap: 10,
  fontSize: 10,
  fontWeight: 600,
  flexWrap: 'wrap'
};

const tooltipStyle = {
  position: 'absolute',
  top: 10,
  right: 16,
  background: '#131824',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '8px 12px',
  fontSize: 11,
  fontFamily: 'monospace',
  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  lineHeight: 1.55
};

const tableStyle = {
  width: '100%',
  fontSize: 11,
  borderCollapse: 'collapse',
  textAlign: 'left',
  fontFamily: 'monospace',
  minWidth: 760
};

const tableHeadStyle = {
  borderBottom: '1px solid #1e2433',
  color: '#64748b'
};

const tableRowStyle = eol => ({
  borderBottom: '1px solid #131824',
  color: eol ? '#f87171' : '#cbd5e1'
});

const derivedRowStyle = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '7px 0',
  borderBottom: '1px solid #131824',
  color: '#cbd5e1',
  fontSize: 12
};

const infoBoxStyle = {
  marginTop: 18,
  padding: 12,
  background: '#090a0f',
  borderRadius: 6,
  border: '1px solid #1e2433',
  fontSize: 11,
  color: '#94a3b8',
  lineHeight: 1.55
};

const referenceTextStyle = {
  fontSize: 12,
  color: '#94a3b8',
  lineHeight: 1.6
};

const mutedParagraphStyle = {
  fontSize: 12,
  color: '#94a3b8',
  margin: '0 0 12px',
  lineHeight: 1.5
};

const warningStyle = active => ({
  fontSize: 10,
  color: active ? '#fbbf24' : '#64748b',
  margin: '-7px 0 12px'
});

const secondaryButtonStyle = {
  marginTop: 14,
  padding: '7px 10px',
  borderRadius: 6,
  border: '1px solid #334155',
  background: '#131824',
  color: '#cbd5e1',
  cursor: 'pointer',
  fontSize: 11
};

const errorBoxStyle = {
  fontSize: 11,
  color: '#f87171',
  background: '#450a0a',
  padding: '7px 9px',
  borderRadius: 4,
  marginTop: 10
};