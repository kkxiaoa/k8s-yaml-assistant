# Changelog

> 状态：当前维护。
> 用途：记录面向使用者的版本变化、部署边界和已知限制。

## [0.2.0](https://github.com/kkxiaoa/k8s-yaml-assistant/compare/v0.1.0...v0.2.0) (2026-07-26)


### Features

* add production release lifecycle ([a6d12ad](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/a6d12ad2b2430c1cd8bbf0f935085a7ce6f61432))
* add production release lifecycle ([59fa0b8](https://github.com/kkxiaoa/k8s-yaml-assistant/commit/59fa0b81bbe45082f8ee20c51e3aaefab614bb91))

## [Unreleased]

## [0.1.0] - 2026-07-25

### Features

- 建立可复现的生产发布链路，包含独立索引产物、候选镜像、签名和六项发布证据门禁。

### Known limitations

- 当前版本已交付 8,410 条正式索引产物，但尚未部署到生产 K3s；部署形态只承诺单节点、单副本且不承诺高可用。
