sub init()
    m.top.visible = false
    m.panel = m.top.findNode("panel")
    m.list = m.top.findNode("list")
    m.list.observeField("itemSelected", "onSelected")
end sub

sub onOpen()
    if not m.top.open then return
    root = CreateObject("roSGNode", "ContentNode")
    i = 0
    for each label in m.top.options
        n = root.createChild("ContentNode")
        if i = m.top.current then n.title = "•  " + label else n.title = "    " + label
        i = i + 1
    end for
    m.top.findNode("heading").text = m.top.title
    m.list.content = root
    rows = m.top.options.Count()
    if rows > 9 then rows = 9
    h = 120 + rows * 72
    m.panel.height = h
    m.panel.translation = [580, Int((1080 - h) / 2)]
    focusAt = m.top.current
    if focusAt < 0 then focusAt = 0
    m.list.jumpToItem = focusAt
    m.top.visible = true
    m.list.setFocus(true)
end sub

sub onSelected()
    m.top.visible = false
    m.top.chosen = m.list.itemSelected
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "back" or key = "options" then
        m.top.visible = false
        m.top.closed = true
        return true
    end if
    ' (The list keeps the highlight while the menu is open.)
    return key = "left" or key = "right" or key = "up" or key = "down"
end function
