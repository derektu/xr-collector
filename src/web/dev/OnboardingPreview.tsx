import { useEffect, useRef, useState } from 'react';
import { Onboarding, type VaultAction, type VaultInspection } from '../Onboarding.js';
import './onboarding-preview.css';

type PreviewScenario = 'first-run' | 'empty' | 'existing' | 'invalid' | 'missing';
type NextSelection = 'empty' | 'existing' | 'invalid' | 'cancel';

const paths = { empty: '/Users/demo/Documents/XR Collector', existing: '/Volumes/Archive/Research Vault', invalid: '/Users/demo/Desktop/Project Files' };

function inspectionFor(scenario: PreviewScenario | NextSelection): VaultInspection {
  if (scenario === 'empty') return { kind: 'empty', path: paths.empty };
  if (scenario === 'existing') return { kind: 'existing', path: paths.existing, documentCount: 128 };
  if (scenario === 'invalid') return { kind: 'invalid', path: paths.invalid, reason: '這個目錄包含其他檔案，無法辨識為 XR Collector 知識庫。' };
  return { kind: 'none' };
}

export default function OnboardingPreview() {
  const [scenario, setScenario] = useState<PreviewScenario>('first-run');
  const [inspection, setInspection] = useState<VaultInspection>({ kind: 'none' });
  const [nextSelection, setNextSelection] = useState<NextSelection>('empty');
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [result, setResult] = useState('尚未執行主要操作');
  const inspectionSequence = useRef(0);

  useEffect(() => {
    inspectionSequence.current += 1;
    setInspection(inspectionFor(scenario));
    setResult('尚未執行主要操作');
  }, [scenario]);

  function chooseDirectory() {
    if (nextSelection === 'cancel') {
      setResult('模擬：使用者取消目錄選擇，畫面狀態保持不變');
      return;
    }
    const sequence = ++inspectionSequence.current;
    setInspection({ kind: 'inspecting', path: paths[nextSelection] });
    setResult('模擬：正在檢查選擇的目錄');
    window.setTimeout(() => {
      if (sequence !== inspectionSequence.current) return;
      setInspection(inspectionFor(nextSelection));
      setResult('模擬：目錄檢查完成');
    }, 450);
  }

  function continueWith(action: VaultAction, path: string) {
    setResult(`模擬：${action === 'create' ? '建立' : '開啟'} ${path}（未寫入檔案）`);
  }

  return <div className="fixture-preview" data-theme={theme === 'light' ? 'silverblue' : 'duskblue'}>
    <aside className="fixture-toolbar" aria-label="開發預覽控制">
      <strong>DEVELOPMENT FIXTURE · 不會操作真實檔案</strong>
      <label>畫面情境<select value={scenario} onChange={(event) => setScenario(event.target.value as PreviewScenario)}><option value="first-run">首次使用</option><option value="empty">已選空目錄</option><option value="existing">已選既有知識庫</option><option value="invalid">無效目錄</option><option value="missing">原位置遺失</option></select></label>
      <label>下次選擇目錄<select value={nextSelection} onChange={(event) => setNextSelection(event.target.value as NextSelection)}><option value="empty">回傳空目錄</option><option value="existing">回傳既有知識庫</option><option value="invalid">回傳無效目錄</option><option value="cancel">取消選擇</option></select></label>
      <label>主題<select value={theme} onChange={(event) => setTheme(event.target.value as 'dark' | 'light')}><option value="dark">深色</option><option value="light">淺色</option></select></label>
      <output aria-live="polite">{result}</output>
    </aside>
    <div className="fixture-product-frame">
      <Onboarding inspection={inspection} suggestedPath="~/Documents/XR Collector" originalFailure={scenario === 'missing' ? { path: '/Volumes/Work/Knowledge', reason: '找不到先前使用的目錄。請重新選擇知識庫位置。' } : undefined} onChooseDirectory={chooseDirectory} onContinue={continueWith} />
    </div>
  </div>;
}
