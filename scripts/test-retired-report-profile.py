"""Pure synthetic projections only, no Root/Node/SSH/PG."""
import copy,importlib.util,json,pathlib,tempfile,unittest
p=pathlib.Path(__file__).with_name('inspect-retired-report-profile.py');s=importlib.util.spec_from_file_location('probe',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Profile(unittest.TestCase):
 def fixture(self):
  inventory={'contractVersion':'sim-driver-report-inventory-v1','fileCount':0,'bytes':0,'activeProducerCount':0,'producerMatches':[],'lockPresent':False,'inventoryDigest':'a'*64,'privateUnexpected':'synthetic-secret-do-not-output'}
  post={'sourceRevision':m.SOURCE,'retiredCronSha256':m.CRON_SHA,'originalInventoryDigest':m.ORIGINAL,'legacyCleanupRetired':True,'otherProducerSourcesUnchanged':True,'databaseContacted':False,'erasureEnabled':False,'reportInventory':inventory}
  transition={'sourceRevision':m.SOURCE,'expectedRetiredCronSha256':m.CRON_SHA,'original':{'inventoryDigest':m.ORIGINAL},'resulting':copy.deepcopy(inventory),'otherProducerSourcesUnchanged':True}
  return post,transition,copy.deepcopy(inventory)
 def test_projection_no_names_cron_or_unknown_receipt_fields(self):
  out=m.safe_projection(*self.fixture(),'b'*64,{'post-stop-inventory.json':'c'*64});self.assertTrue(out['currentSelectedProducersClear']);self.assertFalse(out['productionAcceptance']);self.assertNotIn('synthetic-secret',json.dumps(out))
 def test_lineage_mismatch_rejected(self):
  for field,value in [('sourceRevision','unknown'),('retiredCronSha256','0'*64),('originalInventoryDigest','0'*64),('otherProducerSourcesUnchanged',False),('erasureEnabled',True),('databaseContacted',True)]:
   a,b,c=self.fixture();a[field]=value
   with self.assertRaises(RuntimeError):m.safe_projection(a,b,c,'b'*64,{})
 def test_current_activity_is_reported_not_accepted(self):
  a,b,c=self.fixture();c['activeProducerCount']=1
  out=m.safe_projection(a,b,c,'b'*64,{});self.assertFalse(out['currentSelectedProducersClear']);self.assertFalse(out['productionAcceptance'])
 def test_poststop_nonzero_or_binding_drift_rejected(self):
  a,b,c=self.fixture();b['resulting']['inventoryDigest']='d'*64
  with self.assertRaises(RuntimeError):m.safe_projection(a,b,c,'b'*64,{})
 def test_invalid_inventory_rejected(self):
  for field,value in [('fileCount',True),('bytes',-1),('producerMatches',None),('lockPresent',0),('inventoryDigest','bad')]:
   a,b,c=self.fixture();c[field]=value
   with self.assertRaises(RuntimeError):m.safe_projection(a,b,c,'b'*64,{})
 def test_read_regular_refuses_symlink(self):
  with tempfile.TemporaryDirectory(dir='/private/tmp')as d:
   root=pathlib.Path(d);(root/'public').write_bytes(b'synthetic');(root/'link').symlink_to('public')
   with self.assertRaises(RuntimeError):m.read_regular(root/'link')
if __name__=='__main__':unittest.main()
