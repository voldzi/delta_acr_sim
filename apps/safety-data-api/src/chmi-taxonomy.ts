export type ChmiClassificationBasis = "source_code" | "awareness_type" | "text_fallback";

export interface ChmiEventCode {
  valueName?: string;
  value?: string;
}

export interface ChmiParameter {
  valueName?: string;
  value?: string;
}

export interface ChmiAlertClassification {
  sourceSystem: "CHMI_SIVS" | "CHMI_CAP";
  sourceCode?: string;
  sourceCodeName?: string;
  typeCode: string;
  domain: "air_quality" | "health" | "hydrology" | "weather";
  category: string;
  hazardType: string;
  iconKey: string;
  label: {
    cs: string;
    en: string;
  };
  classificationBasis: ChmiClassificationBasis;
  notificationEligible: boolean;
  isFireWeather: boolean;
  isOutlook: boolean;
}

interface ChmiTaxonomyEntry {
  codes: readonly string[];
  typeCode: string;
  domain: ChmiAlertClassification["domain"];
  category: string;
  hazardType: string;
  iconKey: string;
  label: {
    cs: string;
    en: string;
  };
  notificationEligible?: boolean;
  isFireWeather?: boolean;
  isOutlook?: boolean;
}

export interface PublicChmiTaxonomyEntry {
  codes: readonly string[];
  typeCode: string;
  domain: ChmiAlertClassification["domain"];
  category: string;
  hazardType: string;
  iconKey: string;
  label: {
    cs: string;
    en: string;
  };
  notificationEligible: boolean;
  isFireWeather: boolean;
  isOutlook: boolean;
}

const CHMI_EVENT_TAXONOMY: readonly ChmiTaxonomyEntry[] = [
  entry(["I.1", "I.2"], "weather.temperature.high", "weather", "temperature_high", "temperature", "temperature-high", "Vysoké teploty", "High temperatures"),
  entry(["II.1", "II.2"], "weather.temperature.low", "weather", "temperature_low", "temperature", "temperature-low", "Nízké teploty", "Low temperatures"),
  entry(["III.1", "III.2", "III.3"], "health.heat_stress", "health", "heat_stress", "temperature", "heat-stress", "Zátěž teplem", "Heat stress"),
  entry(["IV.1", "IV.2", "IV.3"], "health.cold_stress", "health", "cold_stress", "temperature", "cold-stress", "Zátěž chladem", "Cold stress"),
  entry(["V.1", "V.2", "V.3"], "weather.wind.strong", "weather", "wind", "wind", "wind", "Vítr", "Wind"),
  entry(["VI.1", "VI.2", "VI.3"], "weather.snow.hazard", "weather", "snow", "snow", "snow", "Sníh a sněhové jevy", "Snow hazards"),
  entry(["VII.1", "VII.2"], "weather.ice.slippery_roads", "weather", "slippery_roads", "ice", "ice-road", "Náledí a kluzké povrchy", "Slippery roads"),
  entry(["VIII.1", "VIII.2"], "weather.ice.load", "weather", "ice_load", "ice", "ice-load", "Ledovka a námraza", "Ice load"),
  entry(["IX.1", "IX.2", "IX.3"], "weather.thunderstorm.severe", "weather", "thunderstorm", "thunderstorm", "thunderstorm", "Bouřky", "Thunderstorms"),
  entry(["X.1", "X.2", "X.3"], "weather.rain.heavy", "weather", "rain", "rain", "rain", "Déšť", "Rain"),
  entry(["XI.1", "XI.2", "XI.3", "XI.4"], "hydro.flood.warning", "hydrology", "flood", "flood", "flood", "Povodňové jevy", "Floods"),
  entry(["XII.1", "XII.2"], "weather.fire_danger", "weather", "fire_weather_risk", "fire_weather", "fire", "Požární nebezpečí", "Fire danger", {
    isFireWeather: true
  }),
  entry(["XIII.1", "XIII.2", "XIII.3"], "weather.other_hazard", "weather", "other_hazard", "weather_alert", "weather-alert", "Nezařazený hydrometeorologický jev", "Unclassified weather hazard"),
  entry(["REG.NO2"], "air_quality.no2.regulation", "air_quality", "air_quality_no2_regulation", "air_quality", "air-quality", "Regulace NO2", "NO2 regulation"),
  entry(["REG.PM10"], "air_quality.pm10.regulation", "air_quality", "air_quality_pm10_regulation", "air_quality", "air-quality", "Regulace PM10", "PM10 regulation"),
  entry(["REG.SO2"], "air_quality.so2.regulation", "air_quality", "air_quality_so2_regulation", "air_quality", "air-quality", "Regulace SO2", "SO2 regulation"),
  entry(["SMOGSIT.NO2"], "air_quality.no2.smog", "air_quality", "air_quality_no2_smog", "air_quality", "air-quality", "Smogová situace NO2", "NO2 smog situation"),
  entry(["SMOGSIT.O3"], "air_quality.o3.smog", "air_quality", "air_quality_o3_smog", "air_quality", "air-quality", "Smogová situace O3", "O3 smog situation"),
  entry(["SMOGSIT.PM10"], "air_quality.pm10.smog", "air_quality", "air_quality_pm10_smog", "air_quality", "air-quality", "Smogová situace PM10", "PM10 smog situation"),
  entry(["SMOGSIT.SO2"], "air_quality.so2.smog", "air_quality", "air_quality_so2_smog", "air_quality", "air-quality", "Smogová situace SO2", "SO2 smog situation"),
  entry(["WARN.O3"], "air_quality.o3.warning", "air_quality", "air_quality_o3_warning", "air_quality", "air-quality", "Varování O3", "O3 warning"),
  entry(["OUTLOOK"], "weather.outlook", "weather", "weather_outlook", "weather_alert", "weather-alert", "Výhled nebezpečných jevů", "Hazardous phenomena outlook", {
    isOutlook: true,
    notificationEligible: false
  }),
  entry(["D.1", "D.2"], "hydro.drought", "hydrology", "drought", "drought", "drought", "Sucho", "Drought")
] as const;

const TAXONOMY_BY_CODE = new Map<string, ChmiTaxonomyEntry>();
for (const item of CHMI_EVENT_TAXONOMY) {
  for (const code of item.codes) {
    TAXONOMY_BY_CODE.set(normalizeChmiCode(code), item);
  }
}

export function classifyChmiAlert(input: {
  event?: string;
  headline?: string;
  eventCodes?: ChmiEventCode[];
  parameters?: ChmiParameter[];
}): ChmiAlertClassification {
  const sourceCode = preferredEventCode(input.eventCodes);
  if (sourceCode) {
    const item = TAXONOMY_BY_CODE.get(normalizeChmiCode(sourceCode.value));
    if (item) {
      return toClassification(item, {
        classificationBasis: "source_code",
        sourceCode: normalizeChmiCode(sourceCode.value),
        sourceCodeName: sourceCode.valueName,
        sourceSystem: "CHMI_SIVS"
      });
    }
  }

  const awareness = awarenessTypeClassification(input.parameters);
  if (awareness) {
    return awareness;
  }

  return fallbackTextClassification(input.event, input.headline);
}

export function chmiAwarenessLevel(value: string | undefined): { code?: string; color?: string; label?: string } {
  const parts = splitParameterValue(value);
  return {
    code: parts[0],
    color: parts[1],
    label: parts[2]
  };
}

export function chmiParameterValue(parameters: ChmiParameter[] | undefined, valueName: string): string | undefined {
  return parameters?.find((parameter) => parameter.valueName === valueName)?.value;
}

export function normalizeChmiCode(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

export function publicChmiTaxonomyEntries(): PublicChmiTaxonomyEntry[] {
  return CHMI_EVENT_TAXONOMY.map((item) => ({
    codes: item.codes,
    typeCode: item.typeCode,
    domain: item.domain,
    category: item.category,
    hazardType: item.hazardType,
    iconKey: item.iconKey,
    label: item.label,
    notificationEligible: item.notificationEligible ?? true,
    isFireWeather: item.isFireWeather ?? false,
    isOutlook: item.isOutlook ?? false
  }));
}

function entry(
  codes: readonly string[],
  typeCode: string,
  domain: ChmiAlertClassification["domain"],
  category: string,
  hazardType: string,
  iconKey: string,
  labelCs: string,
  labelEn: string,
  options: Partial<Pick<ChmiTaxonomyEntry, "isFireWeather" | "isOutlook" | "notificationEligible">> = {}
): ChmiTaxonomyEntry {
  return {
    codes,
    typeCode,
    domain,
    category,
    hazardType,
    iconKey,
    label: { cs: labelCs, en: labelEn },
    notificationEligible: options.notificationEligible ?? true,
    isFireWeather: options.isFireWeather ?? false,
    isOutlook: options.isOutlook ?? false
  };
}

function preferredEventCode(eventCodes: ChmiEventCode[] | undefined): ChmiEventCode | undefined {
  const values = (eventCodes ?? []).filter((eventCode) => eventCode.value?.trim());
  return (
    values.find((eventCode) => ["SIVS", "HPPS", "SVRS", "HAMR"].includes(normalizeChmiCode(eventCode.valueName))) ??
    values.find((eventCode) => TAXONOMY_BY_CODE.has(normalizeChmiCode(eventCode.value))) ??
    values[0]
  );
}

function awarenessTypeClassification(parameters: ChmiParameter[] | undefined): ChmiAlertClassification | undefined {
  const awarenessType = chmiParameterValue(parameters, "awareness_type");
  const awarenessCode = splitParameterValue(awarenessType)[0];
  const item =
    awarenessCode === "1" ? entry(["awareness:1"], "weather.wind.strong", "weather", "wind", "wind", "wind", "Vítr", "Wind")
      : awarenessCode === "2" ? entry(["awareness:2"], "weather.snow_ice.hazard", "weather", "snow_ice", "ice", "ice-road", "Sníh a námrazové jevy", "Snow and ice")
        : awarenessCode === "3" ? entry(["awareness:3"], "weather.thunderstorm.severe", "weather", "thunderstorm", "thunderstorm", "thunderstorm", "Bouřky", "Thunderstorms")
          : awarenessCode === "5" ? entry(["awareness:5"], "weather.temperature.high", "weather", "temperature_high", "temperature", "temperature-high", "Vysoké teploty", "High temperatures")
            : awarenessCode === "6" ? entry(["awareness:6"], "weather.temperature.low", "weather", "temperature_low", "temperature", "temperature-low", "Nízké teploty", "Low temperatures")
              : awarenessCode === "8" ? entry(["awareness:8"], "weather.fire_danger", "weather", "fire_weather_risk", "fire_weather", "fire", "Požární nebezpečí", "Fire danger", { isFireWeather: true })
                : awarenessCode === "10" ? entry(["awareness:10"], "weather.rain.heavy", "weather", "rain", "rain", "rain", "Déšť", "Rain")
                  : awarenessCode === "11" ? entry(["awareness:11"], "hydro.flood.warning", "hydrology", "flood", "flood", "flood", "Povodňové jevy", "Floods")
                    : undefined;
  if (!item) {
    return undefined;
  }
  return toClassification(item, {
    classificationBasis: "awareness_type",
    sourceCode: awarenessCode ? `AWARENESS.${awarenessCode}` : undefined,
    sourceCodeName: "awareness_type",
    sourceSystem: "CHMI_CAP"
  });
}

function fallbackTextClassification(event: string | undefined, headline: string | undefined): ChmiAlertClassification {
  const text = normalizeText(`${event ?? ""} ${headline ?? ""}`);
  const item =
    includesAny(text, ["vitr", "wind"]) ? entry(["text:wind"], "weather.wind.strong", "weather", "wind", "wind", "wind", "Vítr", "Wind")
      : includesAny(text, ["bour", "thunder", "storm"]) ? entry(["text:storm"], "weather.thunderstorm.severe", "weather", "thunderstorm", "thunderstorm", "thunderstorm", "Bouřky", "Thunderstorms")
        : includesAny(text, ["dest", "sraz", "rain"]) ? entry(["text:rain"], "weather.rain.heavy", "weather", "rain", "rain", "rain", "Déšť", "Rain")
          : includesAny(text, ["dotok", "povod", "flood"]) ? entry(["text:flood"], "hydro.flood.warning", "hydrology", "flood", "flood", "flood", "Povodňové jevy", "Floods")
            : includesAny(text, ["snih", "sneh", "snow"]) ? entry(["text:snow"], "weather.snow.hazard", "weather", "snow", "snow", "snow", "Sníh a sněhové jevy", "Snow hazards")
              : includesAny(text, ["naled", "ledov", "namraz", "ice", "slippery"]) ? entry(["text:ice"], "weather.ice.slippery_roads", "weather", "slippery_roads", "ice", "ice-road", "Náledí a kluzké povrchy", "Slippery roads")
                : includesAny(text, ["teplot", "hork", "heat"]) ? entry(["text:temperature"], "weather.temperature.high", "weather", "temperature_high", "temperature", "temperature-high", "Vysoké teploty", "High temperatures")
                  : includesAny(text, ["mraz", "cold"]) ? entry(["text:cold"], "weather.temperature.low", "weather", "temperature_low", "temperature", "temperature-low", "Nízké teploty", "Low temperatures")
                    : includesAny(text, ["pozar", "fire"]) ? entry(["text:fire"], "weather.fire_danger", "weather", "fire_weather_risk", "fire_weather", "fire", "Požární nebezpečí", "Fire danger", { isFireWeather: true })
                      : includesAny(text, ["pm10"]) ? entry(["text:pm10"], "air_quality.pm10.smog", "air_quality", "air_quality_pm10_smog", "air_quality", "air-quality", "PM10", "PM10")
                        : includesAny(text, ["no2", "dusicit"]) ? entry(["text:no2"], "air_quality.no2.smog", "air_quality", "air_quality_no2_smog", "air_quality", "air-quality", "NO2", "NO2")
                          : includesAny(text, ["so2", "siricit"]) ? entry(["text:so2"], "air_quality.so2.smog", "air_quality", "air_quality_so2_smog", "air_quality", "air-quality", "SO2", "SO2")
                            : includesAny(text, ["ozon", "ozone", "o3"]) ? entry(["text:o3"], "air_quality.o3.warning", "air_quality", "air_quality_o3_warning", "air_quality", "air-quality", "Ozon", "Ozone")
                              : entry(["text:weather"], "weather.alert", "weather", "weather_warning", "weather_alert", "weather-alert", "Meteorologická výstraha", "Weather alert");
  return toClassification(item, {
    classificationBasis: "text_fallback",
    sourceSystem: "CHMI_CAP"
  });
}

function toClassification(
  item: ChmiTaxonomyEntry,
  input: {
    classificationBasis: ChmiClassificationBasis;
    sourceCode?: string;
    sourceCodeName?: string;
    sourceSystem: "CHMI_SIVS" | "CHMI_CAP";
  }
): ChmiAlertClassification {
  return {
    sourceSystem: input.sourceSystem,
    sourceCode: input.sourceCode,
    sourceCodeName: input.sourceCodeName,
    typeCode: item.typeCode,
    domain: item.domain,
    category: item.category,
    hazardType: item.hazardType,
    iconKey: item.iconKey,
    label: item.label,
    classificationBasis: input.classificationBasis,
    notificationEligible: item.notificationEligible ?? true,
    isFireWeather: item.isFireWeather ?? false,
    isOutlook: item.isOutlook ?? false
  };
}

function splitParameterValue(value: string | undefined): string[] {
  return (value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
