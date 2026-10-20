sub init()
    m.row = m.top.findNode("row")
    m.top.observeField("focusedChild", "paint")
end sub

sub build()
    while m.row.getChildCount() > 0
        m.row.removeChildIndex(0)
    end while
    for each label in m.top.buttons
        g = m.row.createChild("Group")
        bg = g.createChild("Rectangle")
        bg.height = 72
        t = g.createChild("Label")
        t.font = "font:MediumBoldSystemFont"
        t.text = label
        t.height = 72
        t.vertAlign = "center"
        t.translation = [36, 0]
        w = t.boundingRect().width
        if w < 20 then w = Len(label) * 21
        bg.width = w + 72
    end for
    if m.top.index >= m.top.buttons.Count() then m.top.index = 0
    paint()
end sub

sub paint()
    focused = m.top.hasFocus()
    for i = 0 to m.row.getChildCount() - 1
        g = m.row.getChild(i)
        on = (focused and i = m.top.index) or (not focused and i = m.top.rest)
        if on then
            g.getChild(0).color = "0xFFFFFFFF"
            g.getChild(1).color = "0x000000FF"
        else
            g.getChild(0).color = "0x6D6D6EB3"
            g.getChild(1).color = "0xFFFFFFFF"
        end if
    end for
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    n = m.row.getChildCount()
    ' (At either end the screen gets the key, to move somewhere else.)
    if key = "left" and m.top.index > 0 then
        m.top.index = m.top.index - 1
        return true
    else if key = "right" and m.top.index < n - 1 then
        m.top.index = m.top.index + 1
        return true
    else if key = "OK" and n > 0 then
        m.top.selected = m.top.index
        return true
    end if
    return false
end function
