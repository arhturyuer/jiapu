const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const graph = require('../miniprogram/utils/graph-layout');
const poster = require('../miniprogram/utils/tree-poster');

function source(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

function fixture(spouseCount) {
  const persons = [{ _id: 'hub', name: '中心成员', gender: 'male' }];
  const relations = [];
  function edge(type, from, to) {
    relations.push({ _id: type + ':' + from + ':' + to, type: type, fromPersonId: from, toPersonId: to });
  }
  for (let index = 0; index < spouseCount; index += 1) {
    const spouseId = 'spouse-' + index;
    persons.push({ _id: spouseId, name: '配偶' + index, gender: 'female' });
    edge('spouse', 'hub', spouseId);
    for (let childIndex = 0; childIndex < 2; childIndex += 1) {
      const childId = 'child-' + index + '-' + childIndex;
      persons.push({ _id: childId, name: '孩子' + index + '-' + childIndex });
      edge('parent_child', 'hub', childId);
      edge('parent_child', spouseId, childId);
    }
  }
  persons.push({ _id: 'single-child', name: '单亲子女' });
  edge('parent_child', 'hub', 'single-child');
  return { persons: persons, relations: relations };
}

function interiorCross(line, node, width, height) {
  const minX = Math.min(line.x1, line.x2), maxX = Math.max(line.x1, line.x2);
  const minY = Math.min(line.y1, line.y2), maxY = Math.max(line.y1, line.y2);
  if (line.y1 === line.y2) return line.y1 > node.y + 2 && line.y1 < node.y + height - 2 &&
    maxX > node.x + 2 && minX < node.x + width - 2;
  if (line.x1 === line.x2) return line.x1 > node.x + 2 && line.x1 < node.x + width - 2 &&
    maxY > node.y + 2 && minY < node.y + height - 2;
  return false;
}

function coincidentLength(first, second) {
  if (first.y1 === first.y2 && second.y1 === second.y2 && first.y1 === second.y1) {
    return Math.min(Math.max(first.x1, first.x2), Math.max(second.x1, second.x2)) -
      Math.max(Math.min(first.x1, first.x2), Math.min(second.x1, second.x2));
  }
  if (first.x1 === first.x2 && second.x1 === second.x2 && first.x1 === second.x1) {
    return Math.min(Math.max(first.y1, first.y2), Math.max(second.y1, second.y2)) -
      Math.max(Math.min(first.y1, first.y2), Math.min(second.y1, second.y2));
  }
  return 0;
}

for (const spouseCount of [2, 4, 8]) {
  for (const nameLayout of ['horizontal', 'vertical']) {
    test(spouseCount + ' 位配偶的' + nameLayout + '家谱线路分离并保持子女归属', function () {
      const f = fixture(spouseCount);
      const layout = graph.layoutGraph(f.persons, f.relations, { nameLayout: nameLayout, selectedPersonId: 'hub' });
      const baseLines = layout.lines.filter(function (line) { return !line.isFlow; });
      const childTop = layout.nodes.find(function (node) { return node._id === 'child-0-0'; }).y;
      const hub = layout.nodes.find(function (node) { return node._id === 'hub'; });
      const parentBottom = hub.y + layout.nodeHeight;
      assert.ok(childTop > parentBottom + 48, '家庭轨道必须留在代际通道内');
      if (spouseCount === 8) assert.ok(childTop > parentBottom + 116, '轨道较多时应扩展代际高度');

      const spousePorts = { left: [], right: [] };
      for (let index = 0; index < spouseCount; index += 1) {
        const relationId = 'spouse:hub:spouse-' + index;
        const spouse = layout.nodes.find(function (node) { return node._id === 'spouse-' + index; });
        const side = spouse.x < hub.x ? 'left' : 'right';
        const spouseLines = baseLines.filter(function (line) {
          return line.lineRole === 'spouse' && line.relationIds.includes(relationId);
        });
        assert.equal(spouseLines.length, 1, relationId + ' 应是一条水平夫妻线');
        assert.equal(spouseLines[0].y1, spouseLines[0].y2);
        const sideX = side === 'left' ? hub.x : hub.x + layout.nodeWidth;
        const touching = baseLines.filter(function (line) {
          return line.lineRole === 'spouse' && line.relationIds.includes(relationId) &&
            ((line.x1 === sideX && line.y1 > hub.y && line.y1 < hub.y + layout.nodeHeight) ||
              (line.x2 === sideX && line.y2 > hub.y && line.y2 < hub.y + layout.nodeHeight));
        });
        assert.equal(touching.length, 1, relationId + ' 必须从中心人物的侧边接出一次');
        const hubPortY = touching[0].x1 === sideX ? touching[0].y1 : touching[0].y2;
        spousePorts[side].push(hubPortY);
        const spouseSideX = side === 'left' ? spouse.x + layout.nodeWidth : spouse.x;
        const spouseTouching = baseLines.filter(function (line) {
          return line.lineRole === 'spouse' && line.relationIds.includes(relationId) &&
            ((line.x1 === spouseSideX && line.y1 > spouse.y && line.y1 < spouse.y + layout.nodeHeight) ||
              (line.x2 === spouseSideX && line.y2 > spouse.y && line.y2 < spouse.y + layout.nodeHeight));
        });
        assert.equal(spouseTouching.length, 1, relationId + ' 必须从配偶卡片的侧边接出一次');
        assert.equal(spouseTouching[0].x1 === spouseSideX ? spouseTouching[0].y1 : spouseTouching[0].y2,
          hubPortY, relationId + ' 两端侧边接线必须保持同一水平高度');
        const junction = layout.junctions.find(function (item) { return item._id === 'junction-' + relationId; });
        assert.ok(junction && baseLines.some(function (line) {
          return line.lineRole === 'spouse' && line.relationIds.includes(relationId) &&
            line.y1 === junction.y && line.y2 === junction.y &&
            junction.x >= Math.min(line.x1, line.x2) && junction.x <= Math.max(line.x1, line.x2);
        }), relationId + ' 的子女分叉点必须落在夫妻水平线上');
        assert.ok(baseLines.some(function (line) {
          return line.lineRole === 'trunk' && line.x1 === junction.x && line.y1 === junction.y &&
            line.familyKey.startsWith('pair:hub|' + spouse._id + '@');
        }), relationId + ' 的子女连接必须从夫妻线空隙向下');
        const between = layout.nodes.filter(function (node) {
          return node.y === hub.y && node.x > Math.min(hub.x, spouse.x) && node.x < Math.max(hub.x, spouse.x);
        }).sort(function (first, second) { return first.x - second.x; });
        if (between.length) {
          assert.ok(between.some(function (node) {
            return interiorCross(spouseLines[0], node, layout.nodeWidth, layout.nodeHeight);
          }), relationId + ' 应在中间卡片下方穿过');
          if (side === 'left') {
            assert.ok(junction.x > spouse.x + layout.nodeWidth && junction.x < between[0].x,
              relationId + ' 的子女线应从远端配偶右侧空隙接出');
          } else {
            const nearest = between[between.length - 1];
            assert.ok(junction.x > nearest.x + layout.nodeWidth && junction.x < spouse.x,
              relationId + ' 的子女线应从远端配偶左侧空隙接出');
          }
        }
      }
      for (const side of ['left', 'right']) {
        assert.equal(new Set(spousePorts[side]).size, spousePorts[side].length,
          side + ' 侧多位配偶的卡片接线高度必须不同');
      }

      baseLines.forEach(function (line) {
        if (line.lineRole === 'spouse') return;
        layout.nodes.forEach(function (node) {
          assert.equal(interiorCross(line, node, layout.nodeWidth, layout.nodeHeight), false,
            line._id + ' 穿过 ' + node._id);
        });
      });
      for (let first = 0; first < baseLines.length; first += 1) {
        for (let second = first + 1; second < baseLines.length; second += 1) {
          if (baseLines[first].familyKey === baseLines[second].familyKey) continue;
          assert.ok(coincidentLength(baseLines[first], baseLines[second]) <= 2,
            baseLines[first]._id + ' 与 ' + baseLines[second]._id + ' 重合');
        }
      }

      for (let index = 0; index < spouseCount; index += 1) {
        const spouseId = 'spouse-' + index;
        for (let childIndex = 0; childIndex < 2; childIndex += 1) {
          const childId = 'child-' + index + '-' + childIndex;
          const drop = baseLines.find(function (line) {
            return line.lineRole === 'drop' && line._id.endsWith('-' + childId);
          });
          assert.ok(drop && drop.familyKey.startsWith('pair:hub|' + spouseId + '@'));
          assert.deepEqual(drop.relationIds.slice().sort(), [
            'parent_child:hub:' + childId, 'parent_child:' + spouseId + ':' + childId
          ].sort());
        }
      }
      const singleDrop = baseLines.find(function (line) {
        return line.lineRole === 'drop' && line._id.endsWith('-single-child');
      });
      assert.ok(singleDrop && singleDrop.familyKey.startsWith('single:hub@'));
      assert.deepEqual(singleDrop.relationIds, ['parent_child:hub:single-child']);
      f.relations.forEach(function (relation) {
        assert.ok(baseLines.some(function (line) { return line.relationIds.includes(relation._id); }),
          relation._id + ' 应可由后台可见线路定位');
      });
      assert.ok(layout.lines.some(function (line) {
        return line.isFlow && line.flowRole === 'child-drop' && line.familyKey.startsWith('pair:hub|');
      }));
      layout.crossings.forEach(function (crossing) {
        assert.ok(Number.isFinite(crossing.x) && Number.isFinite(crossing.y));
      });
      if (spouseCount === 4) assert.ok(layout.crossings.length <= 4, '应优先调整轨道顺序减少交叉');
    });
  }
}

test('多配偶布线不受输入顺序影响，折叠后保留可见关系', function () {
  const f = fixture(4);
  f.persons.push({ _id: 'grandchild', name: '孙辈' });
  f.relations.push({ _id: 'parent_child:child-0-0:grandchild', type: 'parent_child',
    fromPersonId: 'child-0-0', toPersonId: 'grandchild' });
  const initial = graph.layoutGraph(f.persons, f.relations);
  const reversed = graph.layoutGraph(f.persons.slice().reverse(), f.relations.slice().reverse());
  assert.deepEqual(initial.nodes.map(function (node) { return [node._id, node.x, node.y]; }),
    reversed.nodes.map(function (node) { return [node._id, node.x, node.y]; }));
  const folded = graph.layoutGraph(f.persons, f.relations, { collapsedIds: ['child-0-0'] });
  assert.equal(folded.nodes.length, initial.nodes.length - 1);
  assert.ok(!folded.lines.some(function (line) {
    return !line.isFlow && line.relationIds.includes('parent_child:child-0-0:grandchild');
  }));
  assert.ok(folded.lines.filter(function (line) { return !line.isFlow; }).every(function (line) {
    return line.x1 >= 0 && line.y1 >= 0 && line.x2 >= 0 && line.y2 >= 0;
  }));
});

test('家谱图片按共享布局绘制跨线标识', function () {
  const f = fixture(4);
  const layout = graph.layoutGraph(f.persons, f.relations);
  const crossing = layout.crossings[0] || { x: 40, y: 40, isSpouse: false };
  layout.crossings = [crossing];
  const sizing = poster.calculateSize(layout);
  const circles = [];
  const ctx = {
    beginPath: function () {}, moveTo: function () {}, lineTo: function () {}, arcTo: function () {},
    closePath: function () {}, fill: function () {}, stroke: function () {}, fillRect: function () {},
    save: function () {}, restore: function () {}, drawImage: function () {},
    arc: function (x, y, radius) { circles.push([x, y, radius]); },
    measureText: function (value) { return { width: String(value).length * 20 }; },
    fillText: function () {}
  };
  poster.draw(ctx, layout, sizing, {}, null, { familyName: '虚构家谱', showGenderColors: true });
  layout.crossings.forEach(function (crossing) {
    assert.ok(circles.some(function (circle) {
      return circle[0] === sizing.graphX + crossing.x && circle[1] === sizing.graphY + crossing.y && circle[2] === 7;
    }), '图片应绘制对应跨线标识');
  });
});

test('用户图、示例图、导出图片和后台预览均由人物卡覆盖穿过的夫妻线', function () {
  for (const page of ['tree', 'example']) {
    const wxml = source('miniprogram/pages/' + page + '/index.wxml');
    const wxss = source('miniprogram/pages/' + page + '/index.wxss');
    assert.ok(wxml.indexOf('wx:for="{{lines}}"') < wxml.indexOf('wx:for="{{nodes}}"'));
    assert.match(wxss, /\.relation-line\s*\{[^}]*z-index:\s*1/s);
    assert.match(wxss, /\.person-node\s*\{[^}]*z-index:\s*4/s);
  }
  const posterSource = source('miniprogram/utils/tree-poster.js');
  const draw = posterSource.slice(posterSource.indexOf('function draw(ctx, layout'));
  assert.ok(draw.indexOf('drawLines(ctx, layout, sizing)') < draw.indexOf('drawNode(ctx, layout, node'));
  const admin = source('admin/src/components/ExampleGraphPreview.vue');
  assert.ok(admin.indexOf('v-for="line in lines"') < admin.indexOf('v-for="node in layout.nodes"'));
});

test('多配偶成员带祖先时，人物视角的远端夫妻线可从卡片下穿过且亲子线避开卡片', function () {
  const f = fixture(4);
  f.persons.push({ _id: 'father', name: '父亲', gender: 'male' }, { _id: 'mother', name: '母亲', gender: 'female' });
  f.relations.push(
    { _id: 'spouse:father:mother', type: 'spouse', fromPersonId: 'father', toPersonId: 'mother' },
    { _id: 'parent_child:father:hub', type: 'parent_child', fromPersonId: 'father', toPersonId: 'hub' },
    { _id: 'parent_child:mother:hub', type: 'parent_child', fromPersonId: 'mother', toPersonId: 'hub' }
  );
  for (const nameLayout of ['horizontal', 'vertical']) {
    const layout = graph.layoutGraph(f.persons, f.relations, {
      mode: 'perspective', viewpointId: 'hub', nameLayout: nameLayout
    });
    layout.lines.filter(function (line) { return !line.isFlow; }).forEach(function (line) {
      if (line.lineRole === 'spouse') return;
      layout.nodes.forEach(function (node) {
        assert.equal(interiorCross(line, node, layout.nodeWidth, layout.nodeHeight), false,
          line._id + ' 穿过 ' + node._id);
      });
    });
    assert.ok(layout.lines.some(function (line) {
      return line.lineRole === 'spouse' && layout.nodes.some(function (node) {
        return interiorCross(line, node, layout.nodeWidth, layout.nodeHeight);
      });
    }));
  }
});
