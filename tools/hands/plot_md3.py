import struct, sys, numpy as np
from PIL import Image, ImageDraw
fn, out, fr = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 30
f=open(fn,'rb').read()
(ident,ver,name,flags,nfr,ntag,nsurf,nskin,ofr,otag,osurf,oend)=struct.unpack('<4si64siiiiiiiii',f[:108])
o=osurf; P=[]; ST=[]; T=[]; base=0
for s_ in range(nsurf):
    (sid,sname,sflags,snfr,snsh,snv,snt,otri,osh,ost,oxyz,osend)=struct.unpack('<4s64s'+'i'*10,f[o:o+108])
    st=np.frombuffer(f[o+ost:o+ost+snv*8],dtype='<f4').reshape(-1,2)
    xyz=np.frombuffer(f[o+oxyz+fr*snv*8:o+oxyz+(fr+1)*snv*8],dtype='<i2').reshape(-1,4)[:,:3]/64.
    tri=np.frombuffer(f[o+otri:o+otri+snt*12],dtype='<i4').reshape(-1,3)+base
    P.append(xyz); ST.append(st); T.append(tri); base+=snv; o+=osend
P=np.vstack(P); ST=np.vstack(ST); T=np.vstack(T); GUN_F=400/1040
kind=np.where(ST[:,1]<GUN_F+0.01,0,np.where(ST[:,0]<0.5,1,2))
S=7; W,H=int(130*S),int(60*S); cols={0:(170,170,170),1:(255,120,90),2:(90,150,255)}
im=Image.new('RGB',(W,2*H),'black'); d=ImageDraw.Draw(im)
for plane,oy in (('xz',0),('xy',H)):
    def pt(p):
        return ((p[0]+15)*S, oy+(10-p[2])*S) if plane=='xz' else ((p[0]+15)*S, oy+(15-p[1])*S)
    for k in (0,2,1):
        for t in T:
            if kind[t[0]]!=k: continue
            d.polygon([pt(P[i]) for i in t], outline=cols[k])
    for x in range(-10,100,10):
        d.line([pt((x,-40,10)),pt((x,-40,-50))] if plane=='xz' else [pt((x,15,0)),pt((x,-45,0))],fill=(70,70,70)); d.text((pt((x,0,0))[0]+2,oy+2),str(x),fill='white')
    rng = range(-50,11,10) if plane=='xz' else range(-45,16,10)
    for v in rng:
        pts=[pt((-15,0,v)),pt((110,0,v))] if plane=='xz' else [pt((-15,v,0)),pt((110,v,0))]
        d.line(pts,fill=(70,70,70)); d.text((2,pts[0][1]-6),('z' if plane=='xz' else 'y')+str(v),fill='white')
im.save(out); print('plot', out)
