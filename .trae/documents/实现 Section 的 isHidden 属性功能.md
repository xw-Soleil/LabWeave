# 实现 Section 的 isHidden 属性功能

## 功能需求

1. **isHidden 属性**：控制 section 内部细节的隐藏状态
2. **移动限制**：隐藏后内部物体不能移动（包括跳跃式移动、普通拖拽、ctrl 拖拽）
3. **删除限制**：隐藏后内部物体不能删除（包括劈砍删除和 del 删除）
4. **跳跃式移动限制**：内部物体不能跳出去，外部物体不能跳进来
5. **操作方式**：右键菜单添加"隐藏 Section 内部细节"项
6. **渲染形态**：隐藏的 分组框显示斜着的线性阴影状态
7. **详细注释**：为 isHidden 属性添加详细注释

## 实现步骤

### 1. 修改 Section.tsx

- 为 isHidden 属性添加详细注释，说明其功能是隐藏内部细节并实现内部锁定效果
- 确保 isHidden 属性在构造函数中正确初始化

### 2. 修改右键菜单

- 在 `context-menu-content.tsx` 中添加"隐藏 Section 内部细节"菜单项
- 实现菜单项的点击逻辑，切换 section 的 isHidden 状态

### 3. 修改移动控制

- **跳跃式移动**：在 `ControllerEntityLayerMoving.tsx` 和 `StageEntityMoveManager.tsx` 中添加 isHidden 检查
- **普通移动**：在 `ControllerEntityClickSelectAndMove.tsx` 中添加 isHidden 检查
- **移动限制逻辑**：检查实体是否在 isHidden 为 true 的 section 内

### 4. 修改删除控制

- **劈砍删除**：在 `ControllerCutting.tsx` 中添加 isHidden 检查
- **del 删除**：在 `StageManager.tsx` 的 deleteSelectedStageObjects 方法中添加 isHidden 检查

### 5. 修改渲染逻辑

- 在 `SectionRenderer.tsx` 中添加隐藏状态的特殊渲染逻辑
- 为隐藏的 分组框添加斜着的线性阴影效果
- 确保隐藏状态下的 分组框有清晰的视觉标识

### 6. 测试验证

- 测试右键菜单的隐藏功能
- 测试隐藏后内部物体的移动限制
- 测试隐藏后内部物体的删除限制
- 测试跳跃式移动的限制
- 测试隐藏 section 的斜线性阴影渲染效果

## 技术要点

- 使用现有的 isHidden 属性，无需添加新属性
- 确保所有移动和删除操作都检查实体是否在隐藏的 section 内
- 为隐藏的 section 添加斜着的线性阴影效果作为视觉标识
- 添加详细的代码注释，便于其他开发者理解
