// dsh-plugin-masterprompt — client bundle (hand-written ModuleLoader form, no
// bundler needed). Renders the "人设" box in the composer tool row
// (`conversation.input.left`, right next to the access-mode control) and the
// expandable persona panel. Talks to the host through the /dsh-mp/* routes.
window.__ModuleLoader__.load({ id: 'dsh-plugin-masterprompt', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  var CSS = [
    '.dshmp-root { position: relative; display: inline-flex; align-items: center; }',
    '.dshmp-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent; color: var(--dsw-alias-label-primary, inherit); font-size: 12px; cursor: pointer; line-height: 1; }',
    '.dshmp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }',
    '.dshmp-btn:disabled { opacity: .45; cursor: default; }',
    '.dshmp-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }',
    '.dshmp-dot.on { background: var(--dsw-alias-state-success-primary, #3da95c); }',
    '.dshmp-panel { position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 10px); width: 340px; max-height: 72vh; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 10px; background: var(--dsw-alias-bg-overlay, #ffffff); color: var(--dsw-alias-label-primary, #1a1a1a); box-shadow: 0 10px 32px rgba(0,0,0,.25); font-size: 12.5px; }',
    '.dshmp-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }',
    '.dshmp-close { border: none; background: transparent; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }',
    '.dshmp-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }',
    '.dshmp-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
    '.dshmp-status { color: var(--dsw-alias-label-secondary, inherit); }',
    '.dshmp-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 8px; }',
    '.dshmp-row.active { border-color: var(--dsw-alias-brand-primary, rgba(64,160,255,.65)); background: var(--dsw-alias-interactive-bg-active, rgba(64,128,255,.10)); }',
    '.dshmp-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.dshmp-mini { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent; color: var(--dsw-alias-label-primary, inherit); cursor: pointer; font-size: 11.5px; }',
    '.dshmp-mini:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }',
    '.dshmp-mini:disabled { opacity: .4; cursor: default; }',
    '.dshmp-mini.primary { background: var(--dsw-alias-button-primary-fill, rgba(64,128,255,.16)); border-color: var(--dsw-alias-brand-primary, rgba(64,128,255,.6)); }',
    '.dshmp-mini.primary:hover { background: var(--dsw-alias-button-primary-hover, rgba(64,128,255,.28)); }',
    '.dshmp-mini.danger { color: var(--dsw-alias-state-error-primary, #e06c6c); border-color: var(--dsw-alias-state-error-primary, rgba(224,108,108,.55)); }',
    '.dshmp-muted { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.8)); font-size: 11px; }',
    '.dshmp-edit { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); padding-top: 8px; }',
    '.dshmp-input, .dshmp-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); color: var(--dsw-alias-label-primary, inherit); font: inherit; padding: 6px 8px; }',
    '.dshmp-input:focus, .dshmp-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary, rgba(64,128,255,.7)); }',
    '.dshmp-textarea { min-height: 130px; resize: vertical; line-height: 1.5; }',
    '.dshmp-actions { display: flex; gap: 6px; justify-content: flex-end; }',
    '.dshmp-msg { white-space: pre-wrap; font-size: 11.5px; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10)); color: var(--dsw-alias-label-secondary, inherit); }',
    '.dshmp-msg.err { color: var(--dsw-alias-state-error-primary, #e08b8b); }',
    '.dshmp-images { display: flex; flex-direction: column; gap: 6px; }',
    '.dshmp-img { display: flex; gap: 8px; align-items: flex-start; padding: 6px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 8px; }',
    '.dshmp-thumb { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); flex: none; background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10)); }',
    '.dshmp-imgbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }',
    '.dshmp-textarea-small { min-height: 54px; font-size: 11.5px; }',
    '.dshmp-file { font-size: 11.5px; color: var(--dsw-alias-label-secondary, inherit); }',
  ].join('\n')

  async function api(name, body) {
    var res
    if (body === undefined) {
      res = await fetch('/dsh-mp/' + name, { cache: 'no-store' })
    } else {
      res = await fetch('/dsh-mp/' + name, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }
    return await res.json()
  }

  var MAX_IMAGES = 4
  var MAX_IMAGE_BYTES = 8 * 1024 * 1024

  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader()
      reader.onload = function () {
        var result = String(reader.result || '')
        var comma = result.indexOf(',')
        resolve(comma >= 0 ? result.slice(comma + 1) : result)
      }
      reader.onerror = function () { reject(new Error('read failed')) }
      reader.readAsDataURL(file)
    })
  }

  function imageUrlOf(image) {
    if (image.previewUrl) return image.previewUrl
    if (image.id) return '/dsh-mp/image?id=' + encodeURIComponent(image.id)
    return ''
  }

  function PersonaBox(props) {
    var sessionId = props.sessionId
    var open = React.useState(false)
    var data = React.useState(null)
    var busy = React.useState(false)
    var msg = React.useState('')
    var editing = React.useState(null)
    var wrapRef = React.useRef(null)

    function refresh() {
      if (!sessionId) return
      return api('state?sid=' + encodeURIComponent(sessionId)).then(function (r) {
        if (r && r.ok) data[1](r)
        else msg[1]('加载失败: ' + String(r && r.error))
      }).catch(function (e) {
        msg[1]('加载失败: ' + String((e && e.message) || e))
      })
    }

    React.useEffect(function () {
      refresh()
    }, [sessionId])

    React.useEffect(function () {
      if (!open[0]) return
      function onDown(ev) {
        if (wrapRef.current && !wrapRef.current.contains(ev.target)) open[1](false)
      }
      function onKey(ev) {
        if (ev.key === 'Escape') open[1](false)
      }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return function () {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open[0]])

    async function doApply(id) {
      if (!sessionId || busy[0]) return
      busy[1](true)
      msg[1]('')
      try {
        var r = await api('apply', { sessionId: sessionId, templateId: id })
        if (r && r.ok) {
          msg[1]('已切换,本对话下一轮回复起生效。')
          await refresh()
        } else msg[1]('切换失败: ' + String(r && r.error))
      } catch (e) {
        msg[1]('切换失败: ' + String((e && e.message) || e))
      }
      busy[1](false)
    }

    async function doClear() {
      if (!sessionId || busy[0]) return
      busy[1](true)
      msg[1]('')
      try {
        var r = await api('clear', { sessionId: sessionId })
        if (r && r.ok) {
          msg[1]('已恢复标准模式,本对话下一轮回复起生效。新对话也将默认为标准模式。')
          await refresh()
        } else msg[1]('操作失败: ' + String(r && r.error))
      } catch (e) {
        msg[1]('操作失败: ' + String((e && e.message) || e))
      }
      busy[1](false)
    }

    function effIds() {
      return (data[0] && Array.isArray(data[0].effective)) ? data[0].effective.map(function (e) { return e.id }) : []
    }

    async function doAppend(id) {
      if (!sessionId || busy[0]) return
      busy[1](true)
      msg[1]('')
      try {
        var ids = effIds()
        if (ids.indexOf(id) < 0) ids = ids.concat([id])
        var r = await api('apply', { sessionId: sessionId, templateIds: ids })
        if (r && r.ok) {
          msg[1]('已叠加,本对话下一轮回复起生效。')
          await refresh()
        } else msg[1]('叠加失败: ' + String(r && r.error))
      } catch (e) {
        msg[1]('叠加失败: ' + String((e && e.message) || e))
      }
      busy[1](false)
    }

    async function doRemove(id) {
      if (!sessionId || busy[0]) return
      busy[1](true)
      msg[1]('')
      try {
        var ids = effIds().filter(function (x) { return x !== id })
        var r = ids.length
          ? await api('apply', { sessionId: sessionId, templateIds: ids })
          : await api('clear', { sessionId: sessionId })
        if (r && r.ok) {
          msg[1]('已移除,本对话下一轮回复起生效。')
          await refresh()
        } else msg[1]('移除失败: ' + String(r && r.error))
      } catch (e) {
        msg[1]('移除失败: ' + String((e && e.message) || e))
      }
      busy[1](false)
    }

    async function doSave() {
      if (!editing[0] || busy[0]) return
      busy[1](true)
      msg[1]('')
      try {
        var images = (editing[0].images || []).map(function (image) {
          return {
            id: image.saved ? image.id : undefined,
            name: image.name,
            mediaType: image.mediaType,
            description: image.description,
            data: image.data,
          }
        })
        var r = await api('save-template', {
          id: editing[0].id || '',
          name: editing[0].name,
          text: editing[0].text,
          images: images,
        })
        if (r && r.ok) {
          msg[1]('已保存模板「' + r.template.name + '」。')
          editing[1](null)
          await refresh()
        } else msg[1]('保存失败: ' + String(r && r.error))
      } catch (e) {
        msg[1]('保存失败: ' + String((e && e.message) || e))
      }
      busy[1](false)
    }

    function openEditor(template) {
      var images = template
        ? (template.images || []).map(function (image) {
            return {
              id: image.id,
              saved: true,
              name: image.name,
              mediaType: image.mediaType,
              description: image.description || '',
              previewUrl: '/dsh-mp/image?id=' + encodeURIComponent(image.id),
            }
          })
        : []
      editing[1]({
        id: template ? template.id : null,
        name: template ? template.name : '',
        text: template ? template.text : '',
        images: images,
      })
    }

    async function addImages(files) {
      if (!editing[0]) return
      var list = Array.prototype.slice.call(files || [])
      var current = editing[0].images || []
      var room = MAX_IMAGES - current.length
      if (room <= 0) {
        msg[1]('每个模板最多 ' + MAX_IMAGES + ' 张参考图。')
        return
      }
      if (list.length > room) {
        msg[1]('每个模板最多 ' + MAX_IMAGES + ' 张参考图,只添加前 ' + room + ' 张。')
        list = list.slice(0, room)
      }
      var added = []
      for (var i = 0; i < list.length; i++) {
        var file = list[i]
        if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
          msg[1]('只支持 PNG / JPEG / WebP / GIF:' + file.name)
          continue
        }
        if (file.size > MAX_IMAGE_BYTES) {
          msg[1]('图片超过 8MB:' + file.name)
          continue
        }
        try {
          var data = await readFileAsBase64(file)
          added.push({
            id: 'new-' + Date.now().toString(36) + '-' + i,
            saved: false,
            name: file.name,
            mediaType: file.type,
            description: '',
            data: data,
            previewUrl: 'data:' + file.type + ';base64,' + data,
          })
        } catch (e) {
          msg[1]('读取失败:' + file.name)
        }
      }
      if (!added.length) return
      editing[1](function (prev) {
        return { id: prev.id, name: prev.name, text: prev.text, images: (prev.images || []).concat(added) }
      })
    }

    function patchImage(id, patch) {
      editing[1](function (prev) {
        return {
          id: prev.id,
          name: prev.name,
          text: prev.text,
          images: (prev.images || []).map(function (image) {
            return image.id === id ? Object.assign({}, image, patch) : image
          }),
        }
      })
    }

    function removeImage(id) {
      editing[1](function (prev) {
        return {
          id: prev.id,
          name: prev.name,
          text: prev.text,
          images: (prev.images || []).filter(function (image) { return image.id !== id }),
        }
      })
    }

    async function doDelete(id) {
      if (busy[0]) return
      busy[1](true)
      msg[1]('')
      try {
        var r = await api('delete-template', { id: id })
        if (r && r.ok) {
          msg[1]('已删除模板。')
          await refresh()
        } else msg[1]('删除失败: ' + String(r && r.error))
      } catch (e) {
        msg[1]('删除失败: ' + String((e && e.message) || e))
      }
      busy[1](false)
    }

    var st = data[0]
    var effective = (st && Array.isArray(st.effective)) ? st.effective : []
    var label = effective.length ? effective.map(function (e) { return e.name }).join(' + ') : '标准'

    var rows = []
    if (st && Array.isArray(st.templates)) {
      rows = st.templates.map(function (t) {
        var active = effective.some(function (e) { return e.id === t.id })
        var inUse = (st.inUse && st.inUse[t.id]) || 0
        var imageCount = (t.images && t.images.length) || 0
        return React.createElement('div', { key: t.id, className: 'dshmp-row' + (active ? ' active' : '') },
          React.createElement('span', { className: 'name' },
            t.name,
            imageCount ? React.createElement('span', { className: 'dshmp-muted' }, '  ' + imageCount + ' 图') : null,
            inUse > 0 ? React.createElement('span', { className: 'dshmp-muted' }, '  ' + inUse + ' 个对话使用中') : null),
          React.createElement('button', { className: 'dshmp-mini primary', disabled: busy[0] || active, onClick: function () { return doApply(t.id) } }, active ? '已生效' : '应用'),
          active
            ? React.createElement('button', { className: 'dshmp-mini', disabled: busy[0], title: '从当前组合中移除', onClick: function () { return doRemove(t.id) } }, '移除')
            : React.createElement('button', { className: 'dshmp-mini', disabled: busy[0], title: '追加到当前组合(多人设叠加)', onClick: function () { return doAppend(t.id) } }, '＋'),
          React.createElement('button', { className: 'dshmp-mini', disabled: busy[0], onClick: function () { openEditor(t) } }, '编辑'),
          React.createElement('button', { className: 'dshmp-mini danger', disabled: busy[0] || inUse > 0, title: inUse > 0 ? '有对话正在使用,需先切换后才能删除' : '删除', onClick: function () { return doDelete(t.id) } }, '删除'))
      })
    }

    var editorImages = (editing[0] && editing[0].images) || []

    var panel = open[0] ? React.createElement('div', { className: 'dshmp-panel' },
      React.createElement('div', { className: 'dshmp-head' },
        React.createElement('span', null, '人设配置'),
        React.createElement('button', { className: 'dshmp-close', onClick: function () { open[1](false) } }, '×')),
      React.createElement('div', { className: 'dshmp-body' },
        React.createElement('div', { className: 'dshmp-status' }, '当前对话: ' + (effective.length ? label : '标准模式(无人设)')),
        rows.length ? rows : React.createElement('div', { className: 'dshmp-muted' }, '还没有人设模板,点下方「新建人设」创建。'),
        editing[0] === null ? React.createElement('div', { className: 'dshmp-actions' },
          React.createElement('button', { className: 'dshmp-mini', disabled: busy[0], onClick: function () { openEditor(null) } }, '新建人设'),
          React.createElement('button', { className: 'dshmp-mini', disabled: busy[0] || !effective.length, onClick: doClear }, '恢复标准模式')) : null,
        editing[0] ? React.createElement('div', { className: 'dshmp-edit' },
          React.createElement('input', {
            className: 'dshmp-input',
            placeholder: '人设名称(必填)',
            value: editing[0].name,
            onChange: function (ev) { editing[1]({ id: editing[0].id, name: ev.target.value, text: editing[0].text, images: editing[0].images }) },
          }),
          React.createElement('textarea', {
            className: 'dshmp-textarea',
            placeholder: '在这里写下人设 / master prompt:思考模式、缓存策略、提问模式、语气、边界……(纯文本,最高 100000 字符)',
            value: editing[0].text,
            onChange: function (ev) { editing[1]({ id: editing[0].id, name: editing[0].name, text: ev.target.value, images: editing[0].images }) },
          }),
          React.createElement('div', { className: 'dshmp-images' },
            React.createElement('div', { className: 'dshmp-muted' }, '参考图(最多 ' + MAX_IMAGES + ' 张;图片本体与下面手写的描述会随每轮请求一起发给模型)'),
            editorImages.map(function (image) {
              return React.createElement('div', { key: image.id, className: 'dshmp-img' },
                React.createElement('img', { className: 'dshmp-thumb', src: imageUrlOf(image), alt: image.name }),
                React.createElement('div', { className: 'dshmp-imgbody' },
                  React.createElement('input', {
                    className: 'dshmp-input',
                    placeholder: '图片名称',
                    value: image.name,
                    onChange: function (ev) { patchImage(image.id, { name: ev.target.value }) },
                  }),
                  React.createElement('textarea', {
                    className: 'dshmp-textarea dshmp-textarea-small',
                    placeholder: '图片描述(手写,例如"布洛妮娅的立绘,灰发,机械义肢")',
                    value: image.description,
                    onChange: function (ev) { patchImage(image.id, { description: ev.target.value }) },
                  }),
                  React.createElement('div', { className: 'dshmp-actions' },
                    React.createElement('button', { className: 'dshmp-mini danger', disabled: busy[0], onClick: function () { removeImage(image.id) } }, '移除'))))
            }),
            React.createElement('input', {
              className: 'dshmp-file',
              type: 'file',
              accept: 'image/png,image/jpeg,image/webp,image/gif',
              multiple: true,
              onChange: function (ev) {
                var picked = Array.prototype.slice.call(ev.target.files || [])
                ev.target.value = ''
                addImages(picked)
              },
            })),
          React.createElement('div', { className: 'dshmp-muted' }, '保存后立即对本对话生效;编辑模板会同步影响所有正在使用它的对话。'),
          React.createElement('div', { className: 'dshmp-actions' },
            React.createElement('button', { className: 'dshmp-mini primary', disabled: busy[0], onClick: doSave }, '保存'),
            React.createElement('button', { className: 'dshmp-mini', disabled: busy[0], onClick: function () { editing[1](null) } }, '取消'))) : null,
        msg[0] ? React.createElement('div', { className: 'dshmp-msg' }, msg[0]) : null)) : null

    if (!sessionId) return null
    return React.createElement('div', { className: 'dshmp-root', ref: wrapRef },
      React.createElement('button', {
        className: 'dshmp-btn',
        title: '点击管理人设(master prompt)',
        onClick: function () { open[1](!open[0]); if (!open[0]) refresh() },
      },
        React.createElement('span', { className: 'dshmp-dot' + (effective.length ? ' on' : '') }),
        '人设 · ' + label),
      panel)
  }

  exports.apply = function apply(ctx) {
    ctx.effect(function () {
      var styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin-css', 'dsh-plugin-masterprompt')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      return function () {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      }
    }, 'dsh-plugin-masterprompt: styles')

    ctx.slots.inject('conversation.input.left', function () {
      return ctx.slots.register(
        { name: 'conversation.input.left', id: 'masterprompt-persona', order: 5, label: '人设' },
        function (props) {
          return React.createElement(PersonaBox, { sessionId: props.sessionId })
        })
    })
  }

  exports.name = 'dsh-plugin-masterprompt'
  exports.inject = ['slots']
  return module.exports
}})
