// Phase B:validateResource(schema 驱动通用校验)单测。纯函数,无需网络/key。
// 运行: npm test

import assert from 'node:assert/strict';
import { validateResource, type ValidationError } from './validate';

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
const has = (errs: ValidationError[], path: string): boolean => errs.some((e) => e.path === path);

const VALID_SC = {
  apiVersion: 'storage.k8s.io/v1',
  kind: 'StorageClass',
  metadata: { name: 'fast-ssd' },
  provisioner: 'ebs.csi.aws.com',
  reclaimPolicy: 'Retain',
  volumeBindingMode: 'WaitForFirstConsumer',
  allowVolumeExpansion: true,
};

console.log('validateResource:');

check('合法 StorageClass → 0 错误', () => assert.deepEqual(validateResource(VALID_SC), []));

check('非对象 → path ""', () => {
  assert.equal(validateResource(null)[0]?.path, '');
  assert.equal(validateResource([1, 2])[0]?.path, '');
});

check('kind 缺失 → 报 kind', () => assert.equal(validateResource({ apiVersion: 'v1' })[0]?.path, 'kind'));

check('未收录的 kind → 提示无法校验', () => {
  const e = validateResource({ kind: 'FooBar', metadata: { name: 'x' } });
  assert.ok(e.some((x) => x.message.includes('未收录')));
});

check('apiVersion 不一致', () => {
  const e = validateResource({ ...VALID_SC, apiVersion: 'storage.k8s.io/v1beta1' });
  assert.ok(has(e, 'apiVersion'));
});

check('metadata.name 缺失', () => {
  const { metadata: _omit, ...rest } = VALID_SC;
  assert.ok(has(validateResource(rest), 'metadata.name'));
});

check('name 违反 DNS-1123', () => {
  const e = validateResource({ ...VALID_SC, metadata: { name: 'Fast_SSD' } });
  assert.ok(has(e, 'metadata.name'));
});

check('provisioner 缺失(required)', () => {
  const { provisioner: _omit, ...rest } = VALID_SC;
  const e = validateResource(rest);
  assert.ok(e.some((x) => x.path === 'provisioner' && x.message.includes('必填')));
});

check('reclaimPolicy 非法枚举', () => {
  const e = validateResource({ ...VALID_SC, reclaimPolicy: 'Archive' });
  assert.ok(has(e, 'reclaimPolicy'));
});

check('volumeBindingMode 非法枚举', () => {
  const e = validateResource({ ...VALID_SC, volumeBindingMode: 'Lazy' });
  assert.ok(has(e, 'volumeBindingMode'));
});

check('类型不对(allowVolumeExpansion 给字符串)', () => {
  const e = validateResource({ ...VALID_SC, allowVolumeExpansion: 'yes' });
  assert.ok(e.some((x) => x.path === 'allowVolumeExpansion' && x.message.includes('类型')));
});

check('未知字段(provisionr 拼错)', () => {
  const e = validateResource({ ...VALID_SC, provisionr: 'typo' });
  assert.ok(e.some((x) => x.path === 'provisionr' && x.message.includes('未知字段')));
});

check('通用性:合法 PVC → 0 错误', () => {
  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'my-pvc' },
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'fast', volumeMode: 'Filesystem' },
  };
  assert.deepEqual(validateResource(pvc), []);
});

check('PVC 嵌套字段枚举非法(spec.accessModes)', () => {
  const pvc = {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'my-pvc' },
    spec: { accessModes: ['ReadWriteFoo'] },
  };
  const e = validateResource(pvc);
  assert.ok(e.some((x) => x.path.startsWith('spec.accessModes')));
});

check('IntOrString 联合类型接受整数或字符串并拒绝 boolean', () => {
  const service = (targetPort: unknown) => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'web' },
    spec: { ports: [{ port: 80, targetPort }] },
  });

  assert.equal(has(validateResource(service(8080)), 'spec.ports[0].targetPort'), false);
  assert.equal(has(validateResource(service('http')), 'spec.ports[0].targetPort'), false);
  const errors = validateResource(service(true));
  assert.ok(
    errors.some(
      (error) =>
        error.path === 'spec.ports[0].targetPort' &&
        error.message.includes('联合类型'),
    ),
  );
});

check('Quantity 联合类型接受字符串或数字并拒绝对象', () => {
  const pvc = (storage: unknown) => ({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: 'my-pvc' },
    spec: { resources: { requests: { storage } } },
  });

  assert.equal(
    has(validateResource(pvc('1Gi')), 'spec.resources.requests.storage'),
    false,
  );
  assert.equal(
    has(validateResource(pvc(1)), 'spec.resources.requests.storage'),
    false,
  );
  const errors = validateResource(pvc({ value: '1Gi' }));
  assert.ok(
    errors.some(
      (error) =>
        error.path === 'spec.resources.requests.storage' &&
        error.message.includes('联合类型'),
    ),
  );
});

console.log(`\n通过 ${passed} 项`);
