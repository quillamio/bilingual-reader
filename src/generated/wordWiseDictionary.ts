// Lightweight fallback used by tests and offline development. `npm run build`
// replaces this file with a compact ECDICT-derived dictionary before packaging.
export type WordWiseDictionaryEntry = readonly [string, number, number, number];

export const WORDWISE_DICTIONARY: Readonly<Record<string, WordWiseDictionaryEntry>> = {
  aneurysm: ["动脉瘤", 0, 1, 0],
  angiogenesis: ["血管生成", 0, 1, 0],
  apoptosis: ["细胞凋亡", 0, 1, 0],
  autophagy: ["自噬", 0, 1, 0],
  cardiomyopathy: ["心肌病", 0, 1, 0],
  endothelium: ["内皮", 0, 1, 0],
  extracellular: ["细胞外的", 0, 1, 0],
  fibrillin: ["原纤维蛋白", 0, 1, 0],
  inflammation: ["炎症", 1, 1, 0],
  mitochondrial: ["线粒体的", 0, 1, 0],
  neurodegeneration: ["神经退行性变", 0, 1, 0],
  polyamine: ["多胺", 0, 1, 0],
  spermidine: ["亚精胺", 0, 1, 0],
  vasculopathy: ["血管病变", 0, 1, 0],
};

export const WORDWISE_DICTIONARY_SOURCE = "fallback";
