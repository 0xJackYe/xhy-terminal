/** Synthetic test records only. Never read or copy the owner's runtime diary. */
const fixture = {
  schemaVersion: 1,
  timezone: 'Asia/Shanghai',
  updatedAt: '2026-10-25T00:00:00Z',
  days: [
    {
      date: '2026-10-23', title: '合成饮食记录 A', note: '仅用于自动化测试。',
      source: { label: 'Synthetic fixture', reportedAt: '2026-10-25' },
      meals: [{
        id: 'fixture-breakfast-a', type: 'breakfast', status: 'eaten', title: '合成早餐', note: '保留餐食备注。',
        items: [{
          id: 'fixture-milk-a', foodId: 'milk-whole', name: '全脂牛奶', amount: 250, unit: 'ml',
          basis: '液态；体积按近似密度换算', estimatedPortion: true,
          note: '合成测试：250ml 暂按 250g，1ml≈1g，实际品牌密度未核实。',
          nutrition: { kcal: 152.5, protein: 7.88, carbs: 11.95, fat: 8.18, fiber: 0, saturatedFat: 4.66 },
        }],
      }],
    },
    {
      date: '2026-10-24', title: '合成饮食记录 B', note: '归档日期独立于历史 ID。',
      source: { label: 'Synthetic fixture', reportedAt: '2026-10-25' },
      meals: [
        {
          id: 'fixture-breakfast-b', type: 'breakfast', status: 'eaten', title: '合成鸡蛋早餐', note: '',
          items: [{
            id: 'fixture-egg-b', foodId: 'egg-boiled', name: '水煮鸡蛋', amount: 50, unit: 'g',
            basis: '煮熟后去壳可食部重量', estimatedPortion: true, note: '合成测试：一枚可食部暂按50g。',
            nutrition: { kcal: 77.5, protein: 6.29, carbs: 0.56, fat: 5.31, fiber: 0, saturatedFat: 1.63 },
          }],
        },
        {
          // Deliberately different from the archived day, to catch deriving dates from stable IDs.
          id: 'fixture-2026-10-23-ribeye-meal', type: 'lunch', status: 'eaten', title: '合成牛排午餐',
          note: '合成来源明确标记生重；不补入烹调油。',
          source: { label: 'Synthetic measured portion', reportedAt: '2026-10-25' },
          items: [{
            id: 'fixture-2026-10-23-ribeye-item', foodId: 'ribeye-raw', name: '草饲眼肉牛排（生）',
            amount: 250, unit: 'g', basis: '生重；去骨、含瘦肉和可分离脂肪', estimatedPortion: false,
            note: '合成测试：250g生重，熟重未知。',
            nutrition: { kcal: 542.5, protein: 49.5, carbs: 0.28, fat: 38.03, fiber: 0, saturatedFat: 16.96 },
          }],
        },
        {
          id: 'fixture-planned-dinner-b', type: 'dinner', status: 'planned', title: '合成计划晚餐', note: '尚未确认吃过。',
          items: [{
            id: 'fixture-rice-b', foodId: 'rice-cooked', name: '白米饭', amount: 150, unit: 'g',
            basis: '熟重；无额外油', estimatedPortion: true, note: '仅为测试计划餐。',
            nutrition: { kcal: 195, protein: 4.04, carbs: 42.26, fat: 0.42, fiber: 0.6, saturatedFat: 0.12 },
          }],
        },
      ],
    },
  ],
};

export const createDiaryFixture = () => structuredClone(fixture);
