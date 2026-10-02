#!/bin/sh
# 端到端测试：对本机测试环境（scripts/dev-up.sh 启动的）跑接口测试和界面测试。
#   ./scripts/test-e2e.sh            # 测试环境已经起来了
#   ./scripts/test-e2e.sh --fresh    # 先启动测试环境、补充测试数据
# 界面测试需要 Chrome，路径不同时用 CHROME_PATH 指定
set -e
cd "$(dirname "$0")/.."

if [ "$1" = "--fresh" ]; then
  sh scripts/dev-up.sh
  sh scripts/dev-fixtures.sh
fi

(cd tests && [ -d node_modules ] || npm ci --no-audit --no-fund)

failed=0
for t in api.test.ts ui.test.mjs ui-map.test.mjs ui-tianditu.test.mjs ui-new.test.mjs ui-ux.test.mjs; do
  echo
  echo "==================== $t"
  node --disable-warning=ExperimentalWarning "tests/$t" || failed=1
done
exit $failed
