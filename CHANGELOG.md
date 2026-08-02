# Changelog

> 状态：当前维护。
> 用途：记录面向使用者的版本变化、部署边界和已知限制。

## [0.4.0](https://github.com/kkxiaoa/k8s-yaml-assistant/compare/v0.3.1...v0.4.0) (2026-08-01)


### Features

* add response feedback loop ([#40](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/40)) ([8a14c25](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/8a14c258a33ecbba0e016aecef13762ce6e8bd2a))

## [0.3.1](https://github.com/kkxiaoa/k8s-yaml-assistant/compare/v0.3.0...v0.3.1) (2026-08-01)


### Bug Fixes

* preserve streaming through Traefik ([#38](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/38)) ([8c63b57](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/8c63b571fe71d0f17f42346a56f4aa1e0620b74c))

## [0.3.0](https://github.com/kkxiaoa/k8s-yaml-assistant/compare/v0.2.0...v0.3.0) (2026-08-01)


### Features

* add application branding icons ([#34](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/34)) ([48a4ef6](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/48a4ef630adfd452744223a20e6dc54114ec4778))
* enable production model access gate ([#36](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/36)) ([85642fd](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/85642fda3faaf01a0f75079a442cdfaf3fbac178))
* redirect application HTTP traffic to HTTPS ([#37](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/37)) ([50f7b5c](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/50f7b5c3d7735e97c8e7f69cdf27df9b4d5eec87))


### Bug Fixes

* extend GitHub OAuth callback timeout ([#32](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/32)) ([858ce33](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/858ce33312a46e18cb0b2ba6d008f946822b152b))
* make control store writes atomic ([#33](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/33)) ([c376645](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/c37664505c751334a2d330c9a309f6e665d5ab95))
* normalize draft release readback ([#27](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/27)) ([58f598f](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/58f598f80b9f9eb7957c1bb4d8d0e2fa262cb185))

## [0.2.0](https://github.com/kkxiaoa/k8s-yaml-assistant/compare/v0.1.1...v0.2.0) (2026-07-30)


### Features

* add controlled public experience ([#23](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/23)) ([aba5654](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/aba5654963391cf5ee1f3e9505fc6f2c3085ac72))
* enforce bounded API request contracts ([#22](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/22)) ([699261d](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/699261ddc6ffa73fd29905aebf3a28a6047ac2d7))
### Bug Fixes

* remove low-value release validation blockers ([#18](https://github.com/kkxiaoa/k8s-yaml-assistant/issues/18)) ([d43a8b2](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/d43a8b24dee8dcc720d16f90304e6a74f7899ac5))

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
