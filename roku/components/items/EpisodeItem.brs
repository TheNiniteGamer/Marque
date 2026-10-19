sub init()
    m.bg = m.top.findNode("bg")
    m.thumb = m.top.findNode("thumb")
    m.track = m.top.findNode("track")
    m.bar = m.top.findNode("bar")
    m.title = m.top.findNode("title")
    m.length = m.top.findNode("length")
    m.overview = m.top.findNode("overview")
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.thumb.uri = c.HDPosterUrl
    m.title.text = c.title
    m.length.text = c.sub
    m.overview.text = c.description
    p = 0.0
    if c.progress <> invalid then p = c.progress
    m.track.visible = p > 0
    m.bar.visible = p > 0
    m.bar.width = 300 * p
end sub

sub onFocus()
    m.bg.opacity = m.top.focusPercent
end sub
