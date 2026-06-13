// 迭代1:validateStorageClass 单测(纯函数,无需网络/key)。
// 运行: npm test   (tsx src/validate.test.ts)
// 自带极简断言,失败抛错 → 进程非 0 退出。

import assert from 'node:assert/strict';
import { validateStorageClass, type ValidationError } from './validate';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

function paths(errs: ValidationError[]): string[] {
  return errs.map((e) => e.path).sort();
}

console.log('validateStorageClass:');

check('合法的 StorageClass → 0 错误', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'fast-ssd' },
    provisioner: 'ebs.csi.aws.com',
    reclaimPolicy: 'Retain',
    volumeBindingMode: 'WaitForFirstConsumer',
  });
  assert.deepEqual(errs, []);
});

check('非对象输入 → 报 path=""', () => {
  assert.equal(validateStorageClass(null)[0]?.path, '');
  assert.equal(validateStorageClass('foo')[0]?.path, '');
  assert.equal(validateStorageClass([1, 2])[0]?.path, '');
});

check('apiVersion 错 + kind 错', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1beta1',
    kind: 'PVC',
    metadata: { name: 'x' },
    provisioner: 'p',
  });
  assert.deepEqual(paths(errs), ['apiVersion', 'kind']);
});

check('name 缺失 → metadata.name 必填', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    provisioner: 'p',
  });
  assert.ok(errs.some((e) => e.path === 'metadata.name'));
});

check('name 违反 DNS-1123(大写+下划线)', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'Fast_SSD' },
    provisioner: 'p',
  });
  assert.ok(errs.some((e) => e.path === 'metadata.name'));
});

check('provisioner 缺失 → 必填', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'x' },
  });
  assert.ok(errs.some((e) => e.path === 'provisioner'));
});

check('reclaimPolicy / volumeBindingMode 非法枚举', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'x' },
    provisioner: 'p',
    reclaimPolicy: 'Recycle',
    volumeBindingMode: 'Lazy',
  });
  assert.deepEqual(paths(errs), ['reclaimPolicy', 'volumeBindingMode']);
});

check('可选字段缺省不报错', () => {
  const errs = validateStorageClass({
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    metadata: { name: 'x' },
    provisioner: 'p',
  });
  assert.deepEqual(errs, []);
});

console.log(`\n通过 ${passed} 项`);
