sub init()
    m.bg = m.top.findNode("bg")
    m.text = m.top.findNode("text")
end sub

sub onContent()
    if m.top.itemContent <> invalid then m.text.text = m.top.itemContent.title
end sub

sub onFocus()
    if m.top.gridHasFocus and m.top.focusPercent > 0.5 then
        m.bg.color = "0xFFFFFFFF"
        m.text.color = "0x000000FF"
    else
        m.bg.color = "0x333333FF"
        m.text.color = "0xFFFFFFFF"
    end if
end sub
