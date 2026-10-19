sub init()
    m.bg = m.top.findNode("bg")
    m.art = m.top.findNode("art")
    m.scrim = m.top.findNode("scrim")
    m.title = m.top.findNode("title")
    m.track = m.top.findNode("track")
    m.bar = m.top.findNode("bar")
    m.badgeBg = m.top.findNode("badgeBg")
    m.badge = m.top.findNode("badge")
end sub

sub onSize()
    w = m.top.width
    h = m.top.height
    if w <= 0 or h <= 0 then return
    m.bg.width = w
    m.bg.height = h
    m.art.width = w
    m.art.height = h
    m.scrim.width = w
    m.scrim.height = h * 0.65
    m.scrim.translation = [0, h * 0.35]
    m.title.width = w - 32
    m.title.height = h - 24
    m.title.translation = [16, 0]
    m.track.width = w
    m.track.translation = [0, h - 6]
    m.bar.translation = [0, h - 6]
    m.badgeBg.translation = [w - 52, 12]
    m.badge.translation = [w - 52, 12]
    onContent()
end sub

sub onContent()
    c = m.top.itemContent
    if c = invalid then return
    m.art.uri = c.HDPosterUrl
    m.title.text = c.title
    p = 0.0
    if c.progress <> invalid then p = c.progress
    m.track.visible = p > 0
    m.bar.visible = p > 0
    if m.top.width > 0 then m.bar.width = m.top.width * p
    hasBadge = c.badge <> invalid and c.badge <> ""
    m.badgeBg.visible = hasBadge
    m.badge.visible = hasBadge
    if hasBadge then m.badge.text = c.badge
end sub
