# Changelog

> 状态：当前维护。
> 用途：记录面向使用者的版本变化、部署边界和已知限制。

## [0.1.1](https://github.com/kkxiaoa/k8s-yaml-assistant/compare/v0.1.0...v0.1.1) (2026-07-27)


### Bug Fixes

* decode BuildKit provenance request shape ([#12](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/12)) ([04b232a](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/04b232a7b38340b4ac8c47bc2231a8ecaa9f3817))
* isolate production observation data root ([#17](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/17)) ([91bc66c](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/91bc66c8da275bd638ebea3bf293f085787dd96b))
* preserve workflow run attempt links ([#16](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/16)) ([50fe257](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/50fe2578b03a222b473034e5a01630493282558c))
* remove runtime-specific image id gate ([#15](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/15)) ([d40700a](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/d40700ac34ca264df863316710b60275fff759bd))
* verify runtime image identity by layer ([#14](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/14)) ([65dd226](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/65dd22673b40f3ed3b733cf93a7d9db5b0b38ac9))

## [Unreleased]

## [0.1.0] - 2026-07-25

### Features

- 建立可复现的生产发布链路，包含独立索引产物、候选镜像、签名和六项发布证据门禁。

### Bug Fixes

- 升级受影响的运行时依赖，把候选镜像的高危与严重漏洞扫描前移到合并请求门禁，让发布门禁复用单次扫描生成的完整报告，并按 SLSA v1（供应链来源证明版本 1）的 `buildDefinition.buildType` 校验 BuildKit（Docker 构建后端）来源证明。

### Known limitations

- 当前版本已交付 8,410 条正式索引产物，但尚未部署到生产 K3s；部署形态只承诺单节点、单副本且不承诺高可用。
