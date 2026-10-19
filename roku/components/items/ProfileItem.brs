sub init()
    m.frame = m.top.findNode("frame")
    m.square = m.top.findNode("square")
    m.initial = m.top.findNode("initial")
    m.name = m.top.findNode("name")
    m.lock = m.top.findNode("lock")
    m.kids = m.top.findNode("kids")
    m.kidsBg = m.top.findNode("kidsBg")
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.name.text = c.title
    m.initial.text = UCase(Left(c.title, 1))
    m.square.color = c.color
    m.lock.visible = c.needsPin
    m.kids.visible = c.kids
    m.kidsBg.visible = c.kids
end sub

sub onFocus()
    on = m.top.gridHasFocus and m.top.focusPercent > 0.5
    m.frame.visible = on
    if on then m.name.color = "0xFFFFFFFF" else m.name.color = "0xA8A8A8FF"
end sub
